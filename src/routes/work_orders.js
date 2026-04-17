import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const workOrdersRouter = Router();

workOrdersRouter.get("/", requireAuth, requirePermission("fleet.read"), async (req, res, next) => {
  try {
    let q = supabase.from("work_orders").select("*").order("opened_at", { ascending: false }).limit(200);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.status) q = q.eq("status", req.query.status);
    if (req.query.asset_id) q = q.eq("asset_id", req.query.asset_id);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

workOrdersRouter.post("/", requireAuth, requirePermission("fleet.manage"), async (req, res, next) => {
  try {
    const { site_id, asset_id, defect_id, priority_code, assigned_to_user_id, problem_summary } = req.body;
    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site" } });
    const { data, error } = await supabase.from("work_orders").insert({
      organization_id: site.organization_id, site_id, asset_id, defect_id,
      priority_code, assigned_to_user_id,
      status: assigned_to_user_id ? "assigned" : "new",
      problem_summary,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

workOrdersRouter.patch("/:work_order_id", requireAuth, requirePermission("fleet.manage"), async (req, res, next) => {
  try {
    const { status, assigned_to_user_id, repair_summary } = req.body;
    const patch = {};
    if (status) patch.status = status;
    if (assigned_to_user_id) patch.assigned_to_user_id = assigned_to_user_id;
    if (repair_summary) patch.repair_summary = repair_summary;
    if (status === "completed") patch.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from("work_orders").update(patch).eq("id", req.params.work_order_id).select().single();
    if (error) throw error;

    // When WO is marked completed, notify supervisors for verification
    if (status === "completed") {
      const { data: supervisors } = await supabase.from("user_role_grants")
        .select("user_id").eq("site_id", data.site_id).in("role_code", ["supervisor", "fleet_admin"]).eq("active", true);
      const notifs = (supervisors || []).map(s => ({
        organization_id: data.organization_id, site_id: data.site_id, user_id: s.user_id,
        notification_type: "repair_verification",
        title: "Repair awaiting verification",
        body: `Work order completed — verify to return asset to service.`,
        entity_type: "work_order", entity_id: data.id,
      }));
      if (notifs.length) await supabase.from("notifications").insert(notifs);
    }
    res.json({ data });
  } catch (e) { next(e); }
});

// Verify repair (return asset to service)
workOrdersRouter.post("/:work_order_id/verify", requireAuth, requirePermission("approval.return_to_service"), async (req, res, next) => {
  try {
    const { verification_note } = req.body;
    const userId = req.headers["x-user-id"];
    const { data: wo } = await supabase.from("work_orders").select("*").eq("id", req.params.work_order_id).single();
    if (!wo) return res.status(404).json({ error: { code: "not_found" } });

    const { data, error } = await supabase.from("work_orders").update({
      status: "verified", verified_at: new Date().toISOString(), verified_by_user_id: userId,
    }).eq("id", wo.id).select().single();
    if (error) throw error;

    // Return asset to service
    await supabase.from("assets").update({
      operational_state: "available", service_state: "normal", updated_at: new Date().toISOString(),
    }).eq("id", wo.asset_id);

    // Close related defect
    if (wo.defect_id) await supabase.from("defects").update({ status: "verified" }).eq("id", wo.defect_id);

    await supabase.from("audit_events").insert({
      organization_id: wo.organization_id, site_id: wo.site_id, actor_user_id: userId,
      entity_type: "work_order", entity_id: wo.id, event_type: "verified",
      payload_json: { note: verification_note },
    });
    res.json({ data });
  } catch (e) { next(e); }
});
