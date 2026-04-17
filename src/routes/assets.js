import { Router } from "express";
import { supabase } from "../supabase.js";

export const assetsRouter = Router();

// List assets
assetsRouter.get("/", async (req, res, next) => {
  try {
    let q = supabase.from("assets").select("*, asset_documents(*)").eq("active", true);
    if (req.query.site_id) q = q.eq("site_id", req.query.site_id);
    if (req.query.asset_type_code) q = q.eq("asset_type_code", req.query.asset_type_code);
    if (req.query.operational_state) q = q.eq("operational_state", req.query.operational_state);
    if (req.query.service_state) q = q.eq("service_state", req.query.service_state);
    if (req.query.q) q = q.or(`display_name.ilike.%${req.query.q}%,asset_tag.ilike.%${req.query.q}%`);
    q = q.order("asset_tag").limit(500);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Get single asset
assetsRouter.get("/:asset_id", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("assets")
      .select("*, asset_documents(*), asset_tags(*)").eq("id", req.params.asset_id).single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Create asset
assetsRouter.post("/", async (req, res, next) => {
  try {
    const { site_id, asset_tag, display_name, asset_type_code, make, model, model_year, vin_or_serial, plate_number, has_reefer } = req.body;
    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site", message: "Site not found" } });
    const { data, error } = await supabase.from("assets").insert({
      organization_id: site.organization_id, site_id, asset_tag, display_name,
      asset_type_code, make, model, model_year, vin_or_serial, plate_number, has_reefer: !!has_reefer,
    }).select().single();
    if (error) throw error;
    await supabase.from("audit_events").insert({
      organization_id: data.organization_id, site_id: data.site_id,
      entity_type: "asset", entity_id: data.id, event_type: "created", payload_json: { asset_tag },
    });
    res.status(201).json({ data });
  } catch (e) { next(e); }
});

// Update asset
assetsRouter.patch("/:asset_id", async (req, res, next) => {
  try {
    const allowed = ["display_name", "make", "model", "model_year", "vin_or_serial", "plate_number", "has_reefer", "operational_state", "service_state", "notes"];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("assets").update(patch).eq("id", req.params.asset_id).select().single();
    if (error) throw error;
    await supabase.from("audit_events").insert({
      organization_id: data.organization_id, site_id: data.site_id,
      entity_type: "asset", entity_id: data.id, event_type: "updated", payload_json: patch,
    });
    res.json({ data });
  } catch (e) { next(e); }
});

// Resolve tag (QR/NFC)
assetsRouter.post("/resolve-tag", async (req, res, next) => {
  try {
    const { tag_type, tag_value } = req.body;
    const { data: tag, error: te } = await supabase.from("asset_tags")
      .select("asset_id").eq("tag_type", tag_type).eq("tag_value", tag_value).eq("active", true).single();
    if (te || !tag) return res.status(404).json({ error: { code: "tag_not_found", message: "No asset matches this tag" } });
    const { data, error } = await supabase.from("assets").select("*").eq("id", tag.asset_id).single();
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Asset documents
assetsRouter.get("/:asset_id/documents", async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("asset_documents").select("*").eq("asset_id", req.params.asset_id);
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

assetsRouter.post("/:asset_id/documents", async (req, res, next) => {
  try {
    const { document_type, issued_at, expires_at, storage_key, mime_type, checksum } = req.body;
    const { data, error } = await supabase.from("asset_documents").insert({
      asset_id: req.params.asset_id, document_type, issued_at, expires_at,
      storage_key: storage_key || "", mime_type,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});
