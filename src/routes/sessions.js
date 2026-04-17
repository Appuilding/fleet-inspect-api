import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const sessionsRouter = Router();

// Start usage session (sign-out)
sessionsRouter.post("/", requireAuth, requirePermission("session.start"), async (req, res, next) => {
  try {
    const { site_id, asset_id, operator_user_id, shift_code, purpose_code } = req.body;
    const startedBy = req.headers["x-user-id"] || operator_user_id;

    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site", message: "Site not found" } });

    // Check asset isn't already out
    const { data: existing } = await supabase.from("usage_sessions")
      .select("id").eq("asset_id", asset_id)
      .in("status", ["awaiting_inspection", "active", "active_with_open_defect", "blocked"]).maybeSingle();
    if (existing) return res.status(409).json({ error: { code: "already_active", message: "Asset already has an active session" } });

    const { data, error } = await supabase.from("usage_sessions").insert({
      organization_id: site.organization_id, site_id, asset_id, operator_user_id,
      shift_code, status: "awaiting_inspection",
    }).select().single();
    if (error) throw error;

    await supabase.from("assets").update({ operational_state: "in_use", updated_at: new Date().toISOString() }).eq("id", asset_id);
    await supabase.from("audit_events").insert({
      organization_id: data.organization_id, site_id: data.site_id, actor_user_id: startedBy,
      entity_type: "usage_session", entity_id: data.id, event_type: "started",
      payload_json: { asset_id, operator_user_id, shift_code },
    });

    res.status(201).json({ data });
  } catch (e) { next(e); }
});

// List sessions
sessionsRouter.get("/", requireAuth, requirePermission("history.read"), async (req, res, next) => {
  try {
    let q = supabase.from("usage_sessions").select("*").order("started_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.status) q = q.eq("status", req.query.status);
    if (req.query.asset_id) q = q.eq("asset_id", req.query.asset_id);
    if (req.query.operator_user_id) q = q.eq("operator_user_id", req.query.operator_user_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Get one
sessionsRouter.get("/:session_id", requireAuth, requirePermission("history.read"), async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("usage_sessions").select("*").eq("id", req.params.session_id).single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Handoff
sessionsRouter.post("/:session_id/handoff", requireAuth, requirePermission("session.start"), async (req, res, next) => {
  try {
    const { to_user_id, fuel_or_battery_state, reefer_state, damage_reported, notes } = req.body;
    const { data: session } = await supabase.from("usage_sessions")
      .select("asset_id, operator_user_id, organization_id, site_id").eq("id", req.params.session_id).single();
    if (!session) return res.status(404).json({ error: { code: "not_found", message: "Session not found" } });

    const { data, error } = await supabase.from("session_handoffs").insert({
      usage_session_id: req.params.session_id, asset_id: session.asset_id,
      from_user_id: session.operator_user_id, to_user_id,
      fuel_or_battery_state, reefer_state, damage_reported: !!damage_reported, notes,
    }).select().single();
    if (error) throw error;

    await supabase.from("usage_sessions").update({ operator_user_id: to_user_id }).eq("id", req.params.session_id);
    await supabase.from("audit_events").insert({
      organization_id: session.organization_id, site_id: session.site_id,
      actor_user_id: session.operator_user_id, entity_type: "session_handoff", entity_id: data.id,
      event_type: "handoff", payload_json: { from: session.operator_user_id, to: to_user_id },
    });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});
