import { Router } from "express";
import { supabase } from "../supabase.js";

export const tempHoldsRouter = Router();

tempHoldsRouter.get("/", async (req, res, next) => {
  try {
    let q = supabase.from("temperature_holds").select("*, inspections!inner(site_id)").order("created_at", { ascending: false }).limit(100);
    if (req.query.status) q = q.eq("status", req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

tempHoldsRouter.post("/:hold_id/approve", async (req, res, next) => {
  try {
    const { approval_note } = req.body;
    const userId = req.headers["x-user-id"];
    const { data, error } = await supabase.from("temperature_holds").update({
      status: "released", approved_by_user_id: userId,
      approved_at: new Date().toISOString(), approval_note,
    }).eq("id", req.params.hold_id).select().single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

tempHoldsRouter.post("/:hold_id/reject", async (req, res, next) => {
  try {
    const { approval_note } = req.body;
    const userId = req.headers["x-user-id"];
    const { data: hold } = await supabase.from("temperature_holds").select("asset_id").eq("id", req.params.hold_id).single();
    const { data, error } = await supabase.from("temperature_holds").update({
      status: "rejected", approved_by_user_id: userId,
      approved_at: new Date().toISOString(), approval_note,
    }).eq("id", req.params.hold_id).select().single();
    if (error) throw error;
    // Block the asset
    if (hold) await supabase.from("assets").update({
      operational_state: "blocked", service_state: "oos_safety", updated_at: new Date().toISOString(),
    }).eq("id", hold.asset_id);
    res.json({ data });
  } catch (e) { next(e); }
});
