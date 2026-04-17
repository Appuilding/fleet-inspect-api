import { Router } from "express";
import { supabase } from "../supabase.js";

export const returnsRouter = Router();

// Submit a return
returnsRouter.post("/", async (req, res, next) => {
  try {
    const clientEventId = req.headers["x-client-event-id"];
    const deviceId = req.headers["x-device-id"];

    if (clientEventId && deviceId) {
      const { data: receipt } = await supabase.from("client_event_receipts")
        .select("entity_id").eq("device_id", deviceId).eq("client_event_id", clientEventId).maybeSingle();
      if (receipt?.entity_id) {
        const { data: existing } = await supabase.from("returns").select("*").eq("id", receipt.entity_id).single();
        return res.json({ data: { return_id: existing.id, duplicate: true } });
      }
    }

    const {
      site_id, usage_session_id, asset_id, operator_user_id, returned_at,
      quick_return, battery_level_pct, plugged_in_confirmed,
      end_odometer, fuel_level_code, reefer_temp_f,
      return_condition_code, notes,
    } = req.body;

    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site" } });

    const { data: ret, error } = await supabase.from("returns").insert({
      organization_id: site.organization_id, site_id, usage_session_id, asset_id, operator_user_id,
      returned_at, quick_return: !!quick_return,
      battery_level_pct, plugged_in_confirmed,
      end_odometer, fuel_level_code, reefer_temp_f,
      return_condition_code: return_condition_code || "none", notes,
    }).select().single();
    if (error) throw error;

    // Close usage session
    await supabase.from("usage_sessions").update({
      status: "returned", returned_at, closed_at: returned_at,
    }).eq("id", usage_session_id);

    // If return had major issues, create a defect + work order
    const defectIds = [], workOrderIds = [];
    if (return_condition_code === "major") {
      const { data: asset } = await supabase.from("assets").select("display_name").eq("id", asset_id).single();
      const { data: defect } = await supabase.from("defects").insert({
        organization_id: site.organization_id, site_id, asset_id,
        return_id: ret.id, severity_code: "major",
        title: `Major issue reported on return: ${asset?.display_name || asset_id}`,
        description: notes || "", source_type: "return", status: "open",
        created_by_user_id: operator_user_id,
      }).select().single();
      if (defect) {
        defectIds.push(defect.id);
        const { data: wo } = await supabase.from("work_orders").insert({
          organization_id: site.organization_id, site_id, asset_id, defect_id: defect.id,
          priority_code: "high", status: "new",
          problem_summary: `Return defect: ${notes || "operator reported major issue"}`,
        }).select().single();
        if (wo) workOrderIds.push(wo.id);
      }
    }

    // Reset asset operational_state
    const assetPatch = { operational_state: return_condition_code === "major" ? "blocked" : "available", updated_at: new Date().toISOString() };
    if (return_condition_code === "major") assetPatch.service_state = "oos_maintenance";
    await supabase.from("assets").update(assetPatch).eq("id", asset_id);

    await supabase.from("audit_events").insert({
      organization_id: site.organization_id, site_id, actor_user_id: operator_user_id,
      entity_type: "return", entity_id: ret.id, event_type: "submitted",
      payload_json: { condition: return_condition_code, quick_return, defect_count: defectIds.length },
    });

    if (clientEventId && deviceId) {
      await supabase.from("client_event_receipts").insert({
        organization_id: site.organization_id, site_id, device_id: deviceId,
        client_event_id: clientEventId, entity_type: "return", entity_id: ret.id, status: "accepted",
      });
    }

    res.status(201).json({
      data: {
        return_id: ret.id, usage_session_status: "returned",
        asset_operational_state: assetPatch.operational_state,
        asset_service_state: assetPatch.service_state || "normal",
        defect_ids: defectIds, work_order_ids: workOrderIds,
      },
    });
  } catch (e) { next(e); }
});

returnsRouter.get("/", async (req, res, next) => {
  try {
    let q = supabase.from("returns").select("*").order("returned_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.asset_id) q = q.eq("asset_id", req.query.asset_id);
    if (req.query.from) q = q.gte("returned_at", req.query.from);
    if (req.query.to) q = q.lte("returned_at", req.query.to);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});
