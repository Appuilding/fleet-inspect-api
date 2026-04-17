import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const checklistsRouter = Router();

// Resolve active checklist template for asset + inspection type
checklistsRouter.get("/resolve", requireAuth, requirePermission("inspection.create", "inspection.read"), async (req, res, next) => {
  try {
    const { asset_id, inspection_type } = req.query;
    if (!asset_id || !inspection_type) return res.status(400).json({ error: { code: "bad_request", message: "asset_id and inspection_type required" } });

    const { data: asset } = await supabase.from("assets").select("asset_type_code, organization_id, site_id").eq("id", asset_id).single();
    if (!asset) return res.status(404).json({ error: { code: "not_found", message: "Asset not found" } });

    // Find the active template — prefer site-scoped, fall back to org-wide
    let { data: tpl } = await supabase.from("checklist_templates")
      .select("*").eq("asset_type_code", asset.asset_type_code).eq("inspection_type", inspection_type)
      .eq("site_id", asset.site_id).eq("is_active", true)
      .order("version_no", { ascending: false }).limit(1).maybeSingle();

    if (!tpl) {
      const { data: orgTpl } = await supabase.from("checklist_templates")
        .select("*").eq("asset_type_code", asset.asset_type_code).eq("inspection_type", inspection_type)
        .is("site_id", null).eq("is_active", true)
        .order("version_no", { ascending: false }).limit(1).maybeSingle();
      tpl = orgTpl;
    }

    if (!tpl) return res.status(404).json({ error: { code: "no_template", message: "No active checklist template configured" } });

    const [{ data: sections }, { data: items }] = await Promise.all([
      supabase.from("checklist_sections").select("*").eq("checklist_template_id", tpl.id).order("display_order"),
      supabase.from("checklist_items").select("*").eq("checklist_template_id", tpl.id).order("display_order"),
    ]);

    const sectionsWithItems = (sections || []).map(s => ({
      ...s,
      items: (items || []).filter(i => i.section_id === s.id),
    }));

    res.json({
      data: {
        template_id: tpl.id, version_no: tpl.version_no,
        asset_type_code: tpl.asset_type_code, inspection_type: tpl.inspection_type,
        sections: sectionsWithItems,
      },
    });
  } catch (e) { next(e); }
});
