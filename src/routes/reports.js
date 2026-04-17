import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const reportsRouter = Router();

// Dashboard aggregates (role-scoped)
reportsRouter.get("/dashboard", requireAuth, requirePermission("dashboard.read"), async (req, res, next) => {
  try {
    const siteId = req.query.site_id;
    const today = new Date().toISOString().split("T")[0];

    const [{ data: assets }, { data: todaySubs }, { data: sessions }, { data: critSafety }, { data: tempHolds }, { data: expiring }] = await Promise.all([
      supabase.from("assets").select("id, operational_state, service_state").eq(siteId ? "site_id" : "active", siteId || true),
      supabase.from("inspections").select("id, result_code, asset_id").gte("submitted_at", today),
      supabase.from("usage_sessions").select("id").in("status", ["active", "active_with_open_defect"]),
      supabase.from("safety_observations").select("id").in("severity_code", ["critical", "high"]).not("status", "in", "(closed,verified)"),
      supabase.from("temperature_holds").select("id").eq("status", "manager_hold"),
      supabase.from("asset_documents").select("id").lte("expires_at", new Date(Date.now() + 30 * 864e5).toISOString().split("T")[0]),
    ]);

    const totalAssets = assets?.length || 0;
    const inspectedToday = new Set((todaySubs || []).map(s => s.asset_id)).size;
    const oosCount = (assets || []).filter(a => a.operational_state === "blocked").length;
    const activeCount = (sessions || []).length;
    const failRate = todaySubs?.length ? Math.round((todaySubs.filter(s => s.result_code !== "clear").length / todaySubs.length) * 100) : 0;

    res.json({
      data: {
        total_assets: totalAssets,
        inspected_today: inspectedToday,
        compliance_pct: totalAssets > 0 ? Math.round((inspectedToday / totalAssets) * 100) : 0,
        active_sessions: activeCount,
        oos_count: oosCount,
        fail_rate_today: failRate,
        critical_safety_open: (critSafety || []).length,
        temp_holds_pending: (tempHolds || []).length,
        documents_expiring_30d: (expiring || []).length,
      },
    });
  } catch (e) { next(e); }
});

reportsRouter.get("/compliance", requireAuth, requirePermission("reports.read"), async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 864e5).toISOString();
    const to = req.query.to || new Date().toISOString();
    let q = supabase.from("inspections").select("result_code, regulation_family, submitted_at, asset_id").gte("submitted_at", from).lte("submitted_at", to);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.regulation_family && req.query.regulation_family !== "all") q = q.eq("regulation_family", req.query.regulation_family);
    const { data, error } = await q.limit(5000);
    if (error) throw error;
    const total = data.length;
    const clear = data.filter(d => d.result_code === "clear").length;
    const critical = data.filter(d => d.result_code === "critical_oos").length;
    res.json({ data: { total, clear, issues: total - clear, critical_oos: critical, pass_rate: total > 0 ? Math.round((clear / total) * 100) : 0, from, to } });
  } catch (e) { next(e); }
});

reportsRouter.get("/fleet-health", requireAuth, requirePermission("reports.read"), async (req, res, next) => {
  try {
    let q = supabase.from("assets").select("id, asset_tag, display_name, operational_state, service_state");
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

reportsRouter.get("/operators", requireAuth, requirePermission("reports.read"), async (req, res, next) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 864e5).toISOString();
    const to = req.query.to || new Date().toISOString();
    let q = supabase.from("inspections").select("operator_user_id, result_code").gte("submitted_at", from).lte("submitted_at", to);
    if (req.query.operator_user_id) q = q.eq("operator_user_id", req.query.operator_user_id);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    const { data, error } = await q.limit(10000);
    if (error) throw error;
    const byOp = {};
    (data || []).forEach(i => {
      if (!byOp[i.operator_user_id]) byOp[i.operator_user_id] = { inspections: 0, clear: 0 };
      byOp[i.operator_user_id].inspections++;
      if (i.result_code === "clear") byOp[i.operator_user_id].clear++;
    });
    res.json({ data: Object.entries(byOp).map(([user_id, v]) => ({ user_id, ...v, pass_rate: v.inspections > 0 ? Math.round((v.clear / v.inspections) * 100) : 0 })) });
  } catch (e) { next(e); }
});

reportsRouter.get("/alerts", requireAuth, requirePermission("reports.read"), async (req, res, next) => {
  try {
    const siteId = req.query.site_id;
    const [safety, tempHolds, expiring, blocked] = await Promise.all([
      supabase.from("safety_observations").select("id, severity_code, description, opened_at").not("status", "in", "(closed)").limit(50),
      supabase.from("temperature_holds").select("id, asset_id, status").in("status", ["manager_hold", "pending_recheck"]).limit(20),
      supabase.from("asset_documents").select("id, asset_id, document_type, expires_at").lte("expires_at", new Date(Date.now() + 30 * 864e5).toISOString().split("T")[0]).limit(50),
      supabase.from("assets").select("id, asset_tag, display_name").eq("operational_state", "blocked"),
    ]);
    res.json({ data: { safety: safety.data || [], temp_holds: tempHolds.data || [], expiring: expiring.data || [], blocked: blocked.data || [] } });
  } catch (e) { next(e); }
});
