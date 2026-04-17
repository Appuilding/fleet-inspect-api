import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const coachingRouter = Router();

// Self coaching snapshot (for an operator to see their own metrics)
coachingRouter.get("/me", requireAuth, requirePermission("coaching.read_self"), async (req, res, next) => {
  try {
    const userId = req.headers["x-user-id"] || req.query.user_id;
    if (!userId) return res.status(401).json({ error: { code: "no_user" } });

    const from = req.query.from || new Date(Date.now() - 90 * 864e5).toISOString();
    const { data: subs } = await supabase.from("inspections")
      .select("id, result_code, submitted_at").eq("operator_user_id", userId).gte("submitted_at", from).limit(1000);

    const total = subs?.length || 0;
    const clear = (subs || []).filter(s => s.result_code === "clear").length;
    const critical = (subs || []).filter(s => s.result_code === "critical_oos").length;

    // Clean streak (consecutive clear inspections from most recent backward)
    let streak = 0;
    const sorted = (subs || []).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
    for (const s of sorted) { if (s.result_code === "clear") streak++; else break; }

    // Stored coaching snapshot (if any)
    const { data: snap } = await supabase.from("coaching_snapshots")
      .select("*").eq("operator_user_id", userId).order("generated_at", { ascending: false }).limit(1).maybeSingle();

    // Recent coaching notes visible to self
    const { data: notes } = await supabase.from("coaching_notes")
      .select("*").eq("operator_user_id", userId).order("created_at", { ascending: false }).limit(20);

    res.json({
      data: {
        inspection_count: total,
        pass_rate: total > 0 ? Math.round((clear / total) * 100) : 0,
        critical_count: critical,
        clean_streak: streak,
        stored_snapshot: snap || null,
        notes: notes || [],
      },
    });
  } catch (e) { next(e); }
});

// Team snapshots (for managers)
coachingRouter.get("/operators", requireAuth, requirePermission("coaching.read_team"), async (req, res, next) => {
  try {
    const siteId = req.query.site_id;
    const from = req.query.from || new Date(Date.now() - 30 * 864e5).toISOString();
    const to = req.query.to || new Date().toISOString();

    let subQ = supabase.from("inspections")
      .select("operator_user_id, result_code, submitted_at")
      .gte("submitted_at", from).lte("submitted_at", to).limit(10000);
    if (siteId) subQ = subQ.eq("site_id", siteId);
    const { data: subs } = await subQ;

    const byOp = {};
    (subs || []).forEach(s => {
      if (!byOp[s.operator_user_id]) byOp[s.operator_user_id] = { inspections: 0, clear: 0, critical: 0 };
      byOp[s.operator_user_id].inspections++;
      if (s.result_code === "clear") byOp[s.operator_user_id].clear++;
      if (s.result_code === "critical_oos") byOp[s.operator_user_id].critical++;
    });

    // Attach user display names
    const userIds = Object.keys(byOp);
    if (userIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, display_name").in("id", userIds);
      const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u.display_name; });
      const result = userIds.map(uid => ({
        operator_user_id: uid, display_name: userMap[uid] || "?",
        ...byOp[uid],
        pass_rate: byOp[uid].inspections > 0 ? Math.round((byOp[uid].clear / byOp[uid].inspections) * 100) : 0,
      })).sort((a, b) => b.inspections - a.inspections);
      return res.json({ data: result });
    }
    res.json({ data: [] });
  } catch (e) { next(e); }
});

// Add coaching note
coachingRouter.post("/operators/:operator_id/notes", requireAuth, requirePermission("coaching.manage"), async (req, res, next) => {
  try {
    const { note, related_inspection_id } = req.body;
    const authorId = req.headers["x-user-id"];
    const { data: user } = await supabase.from("users").select("organization_id").eq("id", req.params.operator_id).single();
    if (!user) return res.status(404).json({ error: { code: "not_found" } });

    // Find site from a recent inspection or default
    let siteId = null;
    const { data: recent } = await supabase.from("inspections").select("site_id").eq("operator_user_id", req.params.operator_id).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
    if (recent) siteId = recent.site_id;
    else {
      const { data: grant } = await supabase.from("user_role_grants").select("site_id").eq("user_id", req.params.operator_id).not("site_id", "is", null).limit(1).maybeSingle();
      siteId = grant?.site_id;
    }
    if (!siteId) return res.status(400).json({ error: { code: "no_site", message: "Cannot determine operator's site" } });

    const { data, error } = await supabase.from("coaching_notes").insert({
      organization_id: user.organization_id, site_id: siteId,
      operator_user_id: req.params.operator_id,
      author_user_id: authorId, note, related_inspection_id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});
