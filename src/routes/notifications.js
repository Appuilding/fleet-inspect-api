import { Router } from "express";
import { supabase } from "../supabase.js";

export const notificationsRouter = Router();

// List current user's notifications
notificationsRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.headers["x-user-id"] || req.query.user_id;
    if (!userId) return res.status(401).json({ error: { code: "no_user" } });
    const { data, error } = await supabase.from("notifications")
      .select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Create a notification manually
notificationsRouter.post("/", async (req, res, next) => {
  try {
    const { notification_type, title, body, user_id, entity_type, entity_id, site_id } = req.body;
    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    const { data, error } = await supabase.from("notifications").insert({
      organization_id: site?.organization_id, site_id, user_id,
      notification_type, title, body, entity_type, entity_id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

// Mark notification as read
notificationsRouter.post("/:notification_id/read", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("notifications").update({
      is_read: true, read_at: new Date().toISOString(),
    }).eq("id", req.params.notification_id).select().single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});
