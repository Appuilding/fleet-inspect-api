import { Router } from "express";
import { supabase } from "../supabase.js";

export const defectsRouter = Router();

defectsRouter.get("/", async (req, res, next) => {
  try {
    let q = supabase.from("defects").select("*").order("created_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.asset_id) q = q.eq("asset_id", req.query.asset_id);
    if (req.query.status) q = q.eq("status", req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});
