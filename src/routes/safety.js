import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const safetyRouter = Router();

// Create safety observation
safetyRouter.post("/", requireAuth, requirePermission("safety.create"), async (req, res, next) => {
  try {
    const clientEventId = req.headers["x-client-event-id"];
    const deviceId = req.headers["x-device-id"];

    if (clientEventId && deviceId) {
      const { data: receipt } = await supabase.from("client_event_receipts")
        .select("entity_id").eq("device_id", deviceId).eq("client_event_id", clientEventId).maybeSingle();
      if (receipt?.entity_id) {
        const { data: existing } = await supabase.from("safety_observations").select("*").eq("id", receipt.entity_id).single();
        return res.json({ data: existing });
      }
    }

    const {
      site_id, asset_id, reporter_user_id, anonymous,
      observation_type, severity_code, location_text, description,
    } = req.body;

    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site" } });

    const { data, error } = await supabase.from("safety_observations").insert({
      organization_id: site.organization_id, site_id, asset_id,
      reporter_user_id: anonymous ? null : reporter_user_id,
      anonymous: !!anonymous,
      observation_type, severity_code, location_text, description,
      status: "open",
    }).select().single();
    if (error) throw error;

    // Initial audit action
    await supabase.from("safety_case_actions").insert({
      safety_observation_id: data.id, action_type: "created",
      note: "Observation reported", created_by_user_id: anonymous ? null : reporter_user_id,
    });

    // Notify safety managers for high/critical
    if (severity_code === "critical" || severity_code === "high") {
      const { data: safetyMgrs } = await supabase.from("user_role_grants")
        .select("user_id").eq("site_id", site_id).in("role_code", ["safety_manager", "supervisor", "fleet_admin"]).eq("active", true);
      const notifRows = (safetyMgrs || []).map(m => ({
        organization_id: site.organization_id, site_id, user_id: m.user_id,
        notification_type: "safety_assignment",
        title: `${severity_code.toUpperCase()} safety observation`,
        body: description.slice(0, 120),
        entity_type: "safety_observation", entity_id: data.id,
      }));
      if (notifRows.length) await supabase.from("notifications").insert(notifRows);
    }

    await supabase.from("audit_events").insert({
      organization_id: site.organization_id, site_id,
      actor_user_id: anonymous ? null : reporter_user_id,
      entity_type: "safety_observation", entity_id: data.id, event_type: "created",
      payload_json: { observation_type, severity_code },
    });

    if (clientEventId && deviceId) {
      await supabase.from("client_event_receipts").insert({
        organization_id: site.organization_id, site_id, device_id: deviceId,
        client_event_id: clientEventId, entity_type: "safety_observation",
        entity_id: data.id, status: "accepted",
      });
    }

    res.status(201).json({ data });
  } catch (e) { next(e); }
});

// List
safetyRouter.get("/", requireAuth, requirePermission("safety.create", "safety.manage"), async (req, res, next) => {
  try {
    let q = supabase.from("safety_observations").select("*").order("opened_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.status) q = q.eq("status", req.query.status);
    if (req.query.severity_code) q = q.eq("severity_code", req.query.severity_code);
    if (req.query.q) q = q.or(`description.ilike.%${req.query.q}%,location_text.ilike.%${req.query.q}%`);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Get one with actions
safetyRouter.get("/:observation_id", requireAuth, requirePermission("safety.create", "safety.manage"), async (req, res, next) => {
  try {
    const { data: obs, error } = await supabase.from("safety_observations").select("*").eq("id", req.params.observation_id).single();
    if (error) throw error;
    const { data: actions } = await supabase.from("safety_case_actions")
      .select("*").eq("safety_observation_id", obs.id).order("created_at");
    res.json({ data: { ...obs, actions: actions || [] } });
  } catch (e) { next(e); }
});

// Add a workflow action (advance the state machine)
safetyRouter.post("/:observation_id/actions", requireAuth, requirePermission("safety.manage"), async (req, res, next) => {
  try {
    const userId = req.headers["x-user-id"];
    const { action_type, assigned_to_user_id, note, corrective_action, preventive_action, root_cause } = req.body;

    const { data: action, error: ae } = await supabase.from("safety_case_actions").insert({
      safety_observation_id: req.params.observation_id,
      action_type, note, created_by_user_id: userId,
    }).select().single();
    if (ae) throw ae;

    // Update parent observation based on action_type
    const obsPatch = {};
    if (action_type === "assignment" && assigned_to_user_id) {
      obsPatch.assigned_to_user_id = assigned_to_user_id;
      obsPatch.status = "assigned";
    } else if (action_type === "in_progress") {
      obsPatch.status = "in_progress";
    } else if (action_type === "root_cause" && root_cause) {
      obsPatch.root_cause = root_cause;
    } else if (action_type === "corrective_action" && corrective_action) {
      obsPatch.corrective_action = corrective_action;
      obsPatch.status = "action_taken";
    } else if (action_type === "preventive_action" && preventive_action) {
      obsPatch.preventive_action = preventive_action;
    } else if (action_type === "verification") {
      obsPatch.status = "verified";
    } else if (action_type === "closure") {
      obsPatch.status = "closed";
      obsPatch.closed_at = new Date().toISOString();
    }

    if (Object.keys(obsPatch).length > 0) {
      await supabase.from("safety_observations").update(obsPatch).eq("id", req.params.observation_id);
    }
    res.status(201).json({ data: action });
  } catch (e) { next(e); }
});
