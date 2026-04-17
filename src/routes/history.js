import { Router } from "express";
import { supabase } from "../supabase.js";

export const historyRouter = Router();

// Unified event stream — inspections + returns + safety + work orders + audit
historyRouter.get("/events", async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 864e5).toISOString();
    const to = req.query.to || new Date().toISOString();
    const siteId = req.query.site_id;
    const q = (req.query.q || "").toString().toLowerCase();

    const queries = [];

    // Inspections
    let insQ = supabase.from("inspections").select("id, asset_id, operator_user_id, inspection_type, result_code, submitted_at, regulation_family")
      .gte("submitted_at", from).lte("submitted_at", to).order("submitted_at", { ascending: false }).limit(500);
    if (siteId) insQ = insQ.eq("site_id", siteId);
    if (req.query.asset_id) insQ = insQ.eq("asset_id", req.query.asset_id);
    if (req.query.operator_user_id) insQ = insQ.eq("operator_user_id", req.query.operator_user_id);
    queries.push(insQ);

    // Returns
    let retQ = supabase.from("returns").select("id, asset_id, operator_user_id, returned_at, return_condition_code, quick_return")
      .gte("returned_at", from).lte("returned_at", to).order("returned_at", { ascending: false }).limit(500);
    if (siteId) retQ = retQ.eq("site_id", siteId);
    if (req.query.asset_id) retQ = retQ.eq("asset_id", req.query.asset_id);
    queries.push(retQ);

    // Sessions (sign-outs)
    let sessQ = supabase.from("usage_sessions").select("id, asset_id, operator_user_id, started_at, status, shift_code")
      .gte("started_at", from).lte("started_at", to).order("started_at", { ascending: false }).limit(500);
    if (siteId) sessQ = sessQ.eq("site_id", siteId);
    if (req.query.asset_id) sessQ = sessQ.eq("asset_id", req.query.asset_id);
    queries.push(sessQ);

    // Safety observations
    let safeQ = supabase.from("safety_observations").select("id, asset_id, reporter_user_id, observation_type, severity_code, status, opened_at, description")
      .gte("opened_at", from).lte("opened_at", to).order("opened_at", { ascending: false }).limit(500);
    if (siteId) safeQ = safeQ.eq("site_id", siteId);
    queries.push(safeQ);

    const [insR, retR, sessR, safeR] = await Promise.all(queries);

    const events = [];
    (insR.data || []).forEach(i => events.push({
      event_type: "inspection", id: i.id, asset_id: i.asset_id, user_id: i.operator_user_id,
      ts: i.submitted_at, summary: `${i.inspection_type} — ${i.result_code}`, payload: i,
    }));
    (retR.data || []).forEach(r => events.push({
      event_type: "return", id: r.id, asset_id: r.asset_id, user_id: r.operator_user_id,
      ts: r.returned_at, summary: `Return (${r.return_condition_code})${r.quick_return ? " · quick" : ""}`, payload: r,
    }));
    (sessR.data || []).forEach(s => events.push({
      event_type: "session_start", id: s.id, asset_id: s.asset_id, user_id: s.operator_user_id,
      ts: s.started_at, summary: `Signed out · ${s.status}`, payload: s,
    }));
    (safeR.data || []).forEach(so => events.push({
      event_type: "safety_observation", id: so.id, asset_id: so.asset_id, user_id: so.reporter_user_id,
      ts: so.opened_at, summary: `${so.severity_code}: ${so.observation_type}`, payload: so,
    }));

    // Sort all by timestamp descending
    events.sort((a, b) => b.ts.localeCompare(a.ts));

    // Filter by event_type if requested
    let filtered = events;
    if (req.query.event_type) filtered = events.filter(e => e.event_type === req.query.event_type);
    if (q) filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(q));

    res.json({ data: filtered.slice(0, 500) });
  } catch (e) { next(e); }
});
