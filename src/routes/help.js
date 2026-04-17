import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const helpRouter = Router();

helpRouter.get("/articles", requireAuth, requirePermission("help.read"), async (req, res, next) => {
  try {
    let q = supabase.from("help_articles").select("*").eq("is_active", true).order("article_key");
    if (req.query.site_id) q = q.or(`site_id.eq.${req.query.site_id},site_id.is.null`);
    if (req.query.article_key) q = q.eq("article_key", req.query.article_key);
    const { data, error } = await q.limit(200);
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});
