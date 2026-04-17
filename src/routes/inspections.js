import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const inspectionsRouter = Router();

// Submit inspection with full business logic
inspectionsRouter.post("/", requireAuth, requirePermission("inspection.create"), async (req, res, next) => {
  try {
    const clientEventId = req.headers["x-client-event-id"];
    const deviceId = req.headers["x-device-id"];

    // Idempotency: if we've seen this client_event_id, return existing result
    if (clientEventId && deviceId) {
      const { data: receipt } = await supabase.from("client_event_receipts")
        .select("entity_id, status").eq("device_id", deviceId).eq("client_event_id", clientEventId).maybeSingle();
      if (receipt && receipt.entity_id) {
        const { data: existing } = await supabase.from("inspections").select("*").eq("id", receipt.entity_id).single();
        return res.status(200).json({ data: { inspection_id: existing.id, result_code: existing.result_code, duplicate: true } });
      }
    }

    const {
      site_id, asset_id, usage_session_id, operator_user_id,
      inspection_type, checklist_template_id, checklist_template_version, regulation_family,
      shift_code, trip_mode, previous_dvir_acknowledged, previous_dvir_acknowledged_at,
      hour_meter, odometer_start, odometer_end,
      loading_temp_f, load_type_code, recheck_temp_f, temp_confirmed_at,
      comments, gps_lat, gps_lng, geo_status,
      signature_attachment_id, battery_pm_checked_ok,
      damage_marks = [], temperature_hold, item_results = [],
      started_at, submitted_at,
    } = req.body;

    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site", message: "Site not found" } });

    // Compute result_code from item_results
    const hasCritical = await (async () => {
      const itemIds = item_results.map(r => r.checklist_item_id);
      if (!itemIds.length) return false;
      const { data: items } = await supabase.from("checklist_items").select("id, is_critical").in("id", itemIds);
      const critMap = {}; (items || []).forEach(i => { critMap[i.id] = i.is_critical; });
      return item_results.some(r => r.response_code === "fail" && critMap[r.checklist_item_id]);
    })();
    const hasFails = item_results.some(r => r.response_code === "fail");
    const resultCode = hasCritical ? "critical_oos" : hasFails ? "issues_found" : "clear";

    // Insert inspection
    const { data: inspection, error: ie } = await supabase.from("inspections").insert({
      organization_id: site.organization_id, site_id, asset_id, usage_session_id, operator_user_id,
      inspection_type, checklist_template_id, checklist_template_version, regulation_family,
      started_at, submitted_at, result_code,
      previous_dvir_acknowledged, previous_dvir_acknowledged_at,
      shift_code, trip_mode, hour_meter, odometer_start, odometer_end,
      loading_temp_f, load_type_code, recheck_temp_f, temp_confirmed_at,
      comments, gps_lat, gps_lng, geo_status,
    }).select().single();
    if (ie) throw ie;

    // Insert item results
    if (item_results.length) {
      const rows = item_results.map(r => ({
        inspection_id: inspection.id, checklist_item_id: r.checklist_item_id,
        response_code: r.response_code, note: r.note,
      }));
      const { error: re } = await supabase.from("inspection_item_results").insert(rows);
      if (re) throw re;
    }

    // Insert damage marks
    if (damage_marks.length) {
      const rows = damage_marks.map(d => ({
        inspection_id: inspection.id, zone_code: d.zone_code, note: d.note,
      }));
      await supabase.from("inspection_damage_marks").insert(rows);
    }

    // Battery PM event (if provided)
    if (battery_pm_checked_ok !== undefined) {
      await supabase.from("battery_pm_events").insert({
        inspection_id: inspection.id, asset_id, checked_ok: !!battery_pm_checked_ok,
      });
    }

    // Temperature hold (if provided)
    let tempHoldId = null;
    if (temperature_hold) {
      const { data: th } = await supabase.from("temperature_holds").insert({
        inspection_id: inspection.id, asset_id,
        load_type_code: temperature_hold.load_type_code,
        initial_temp_f: temperature_hold.initial_temp_f,
        confirmed_at: temperature_hold.confirmed_at,
        recheck_due_at: temperature_hold.recheck_due_at,
        recheck_temp_f: temperature_hold.recheck_temp_f,
        status: temperature_hold.status || "pending_recheck",
      }).select().single();
      tempHoldId = th?.id;
    }

    // ═══════════════════════════════════════════════════════════
    // BUSINESS LOGIC: Critical fail → auto-create defects + OOS
    // ═══════════════════════════════════════════════════════════
    const defectIds = [], workOrderIds = [];

    if (hasFails) {
      // Find failed items and create defects
      const failedItems = item_results.filter(r => r.response_code === "fail");
      if (failedItems.length > 0) {
        const { data: itemDefs } = await supabase.from("checklist_items")
          .select("id, label_en, is_critical").in("id", failedItems.map(f => f.checklist_item_id));
        const itemMap = {}; (itemDefs || []).forEach(i => { itemMap[i.id] = i; });

        for (const failed of failedItems) {
          const item = itemMap[failed.checklist_item_id];
          if (!item) continue;
          const severity = item.is_critical ? "critical" : "major";
          const { data: defect } = await supabase.from("defects").insert({
            organization_id: site.organization_id, site_id, asset_id,
            inspection_id: inspection.id, severity_code: severity,
            title: item.label_en, description: failed.note || "",
            source_type: "inspection", status: "open",
            created_by_user_id: operator_user_id,
          }).select().single();
          if (defect) {
            defectIds.push(defect.id);
            // Auto-create work order for critical and major defects
            if (severity === "critical" || severity === "major") {
              const { data: wo } = await supabase.from("work_orders").insert({
                organization_id: site.organization_id, site_id, asset_id, defect_id: defect.id,
                priority_code: severity === "critical" ? "critical" : "high",
                status: "new", problem_summary: `${item.label_en}${failed.note ? ": " + failed.note : ""}`,
              }).select().single();
              if (wo) workOrderIds.push(wo.id);
            }
          }
        }
      }
    }

    // State transitions
    let assetOpState = "in_use", assetSvcState = "normal", sessionStatus = "active";
    if (hasCritical) {
      assetOpState = "blocked";
      assetSvcState = "oos_safety";
      sessionStatus = "blocked";
    } else if (hasFails) {
      sessionStatus = "active_with_open_defect";
    }

    await supabase.from("assets").update({
      operational_state: assetOpState, service_state: assetSvcState, updated_at: new Date().toISOString(),
    }).eq("id", asset_id);

    if (usage_session_id) {
      await supabase.from("usage_sessions").update({ status: sessionStatus }).eq("id", usage_session_id);
    }

    // Audit event
    await supabase.from("audit_events").insert({
      organization_id: site.organization_id, site_id,
      actor_user_id: operator_user_id, entity_type: "inspection", entity_id: inspection.id,
      event_type: "submitted",
      payload_json: { result_code: resultCode, defect_count: defectIds.length, work_order_count: workOrderIds.length },
    });

    // Notifications for critical defects
    if (hasCritical) {
      const { data: supervisors } = await supabase.from("user_role_grants")
        .select("user_id").eq("site_id", site_id).in("role_code", ["supervisor", "safety_manager", "fleet_admin"]).eq("active", true);
      const { data: asset } = await supabase.from("assets").select("display_name").eq("id", asset_id).single();
      const notifRows = (supervisors || []).map(s => ({
        organization_id: site.organization_id, site_id, user_id: s.user_id,
        notification_type: "critical_defect",
        title: `Critical defect: ${asset?.display_name || asset_id}`,
        body: `Inspection by operator found ${defectIds.length} critical issue(s). Asset blocked.`,
        entity_type: "inspection", entity_id: inspection.id,
      }));
      if (notifRows.length) await supabase.from("notifications").insert(notifRows);
    }

    // Record client event receipt
    if (clientEventId && deviceId) {
      await supabase.from("client_event_receipts").insert({
        organization_id: site.organization_id, site_id, device_id: deviceId,
        client_event_id: clientEventId, entity_type: "inspection", entity_id: inspection.id,
        status: "accepted",
      });
    }

    res.status(201).json({
      data: {
        inspection_id: inspection.id, result_code: resultCode,
        usage_session_status: sessionStatus,
        asset_operational_state: assetOpState, asset_service_state: assetSvcState,
        defect_ids: defectIds, work_order_ids: workOrderIds,
        temperature_hold_id: tempHoldId,
      },
    });
  } catch (e) { next(e); }
});

// List inspections
inspectionsRouter.get("/", requireAuth, requirePermission("inspection.read"), async (req, res, next) => {
  try {
    let q = supabase.from("inspections").select("id, asset_id, operator_user_id, inspection_type, result_code, submitted_at")
      .order("submitted_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.asset_id) q = q.eq("asset_id", req.query.asset_id);
    if (req.query.operator_user_id) q = q.eq("operator_user_id", req.query.operator_user_id);
    if (req.query.inspection_type) q = q.eq("inspection_type", req.query.inspection_type);
    if (req.query.from) q = q.gte("submitted_at", req.query.from);
    if (req.query.to) q = q.lte("submitted_at", req.query.to);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Get one with item results
inspectionsRouter.get("/:inspection_id", requireAuth, requirePermission("inspection.read"), async (req, res, next) => {
  try {
    const { data: ins, error } = await supabase.from("inspections").select("*").eq("id", req.params.inspection_id).single();
    if (error) throw error;
    const [{ data: items }, { data: damage }] = await Promise.all([
      supabase.from("inspection_item_results").select("*").eq("inspection_id", ins.id),
      supabase.from("inspection_damage_marks").select("*").eq("inspection_id", ins.id),
    ]);
    res.json({ data: { ...ins, item_results: items || [], damage_marks: damage || [] } });
  } catch (e) { next(e); }
});

// Amend immutable inspection
inspectionsRouter.post("/:inspection_id/amendments", requireAuth, requirePermission("inspection.amend"), async (req, res, next) => {
  try {
    const { note } = req.body;
    const userId = req.headers["x-user-id"];
    const { data: ins } = await supabase.from("inspections").select("organization_id, site_id").eq("id", req.params.inspection_id).single();
    if (!ins) return res.status(404).json({ error: { code: "not_found" } });
    const { data, error } = await supabase.from("audit_events").insert({
      organization_id: ins.organization_id, site_id: ins.site_id, actor_user_id: userId,
      entity_type: "inspection", entity_id: req.params.inspection_id,
      event_type: "amended", payload_json: { note },
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});
