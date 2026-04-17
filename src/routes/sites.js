import { Router } from "express";
import { supabase } from "../supabase.js";

export const sitesRouter = Router();

sitesRouter.get("/", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("sites").select("*").eq("active", true).order("name");
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

sitesRouter.get("/:site_id", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("sites").select("*").eq("id", req.params.site_id).single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

sitesRouter.get("/:site_id/policy", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("site_policies")
      .select("*").eq("site_id", req.params.site_id).eq("active", true)
      .order("version_no", { ascending: false }).limit(1).single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});
