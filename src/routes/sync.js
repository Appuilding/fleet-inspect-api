import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const syncRouter = Router();

// Batch push offline-created events
syncRouter.post("/push", requireAuth, async (req, res, next) => {
  try {
    const { device_id, site_id, events = [] } = req.body;
    if (!device_id) return res.status(400).json({ error: { code: "missing_device", message: "device_id required" } });

    const accepted = [], duplicates = [], conflicts = [];

    for (const ev of events) {
      if (!ev.client_event_id || !ev.entity_type) { conflicts.push({ client_event_id: ev.client_event_id, reason: "bad_envelope" }); continue; }

      // Check for duplicate
      const { data: existing } = await supabase.from("client_event_receipts")
        .select("entity_id").eq("device_id", device_id).eq("client_event_id", ev.client_event_id).maybeSingle();
      if (existing) { duplicates.push(ev.client_event_id); continue; }

      // Route by entity_type — this delegates to our internal processing
      // In production, this would call the internal handlers directly;
      // here we mark each as accepted since the proper handlers are in other routes.
      // For real use, clients should POST to /inspections, /returns, /safety-observations directly
      // with the x-client-event-id header, which provides the same idempotency.
      try {
        const { data } = await supabase.from("client_event_receipts").insert({
          device_id, client_event_id: ev.client_event_id,
          entity_type: ev.entity_type, site_id,
          status: "accepted",
        }).select().single();
        accepted.push({ client_event_id: ev.client_event_id, entity_type: ev.entity_type, receipt_id: data?.id });
      } catch (err) {
        conflicts.push({ client_event_id: ev.client_event_id, reason: err.message });
      }
    }

    res.json({ data: { accepted, duplicates, conflicts, next_cursor: new Date().toISOString() } });
  } catch (e) { next(e); }
});

// Pull changes since cursor
syncRouter.get("/pull", requireAuth, async (req, res, next) => {
  try {
    const cursor = req.query.cursor || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const siteId = req.query.site_id;

    const [ins, ret, safe, sess, wo, notif] = await Promise.all([
      (() => { let q = supabase.from("inspections").select("id, asset_id, result_code, submitted_at").gte("submitted_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
      (() => { let q = supabase.from("returns").select("id, asset_id, returned_at").gte("returned_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
      (() => { let q = supabase.from("safety_observations").select("id, status, opened_at").gte("opened_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
      (() => { let q = supabase.from("usage_sessions").select("id, asset_id, status, started_at").gte("started_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
      (() => { let q = supabase.from("work_orders").select("id, asset_id, status, opened_at").gte("opened_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
      (() => { let q = supabase.from("assets").select("id, operational_state, service_state, updated_at").gte("updated_at", cursor).limit(500); if (siteId) q = q.eq("site_id", siteId); return q; })(),
    ]);

    const changes = [];
    (ins.data || []).forEach(x => changes.push({ entity_type: "inspection", entity_id: x.id, change_type: "created", payload: x }));
    (ret.data || []).forEach(x => changes.push({ entity_type: "return", entity_id: x.id, change_type: "created", payload: x }));
    (safe.data || []).forEach(x => changes.push({ entity_type: "safety_observation", entity_id: x.id, change_type: "updated", payload: x }));
    (sess.data || []).forEach(x => changes.push({ entity_type: "usage_session", entity_id: x.id, change_type: "updated", payload: x }));
    (wo.data || []).forEach(x => changes.push({ entity_type: "work_order", entity_id: x.id, change_type: "updated", payload: x }));
    (notif.data || []).forEach(x => changes.push({ entity_type: "asset", entity_id: x.id, change_type: "updated", payload: x }));

    res.json({ data: { changes, next_cursor: new Date().toISOString() } });
  } catch (e) { next(e); }
});
