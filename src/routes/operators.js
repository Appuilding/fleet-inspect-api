import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth, requirePermission } from "../auth.js";

export const operatorsRouter = Router();

// List operators (profiles + users joined)
operatorsRouter.get("/", requireAuth, requirePermission("operator.read"), async (req, res, next) => {
  try {
    const { data: profiles, error } = await supabase.from("operator_profiles").select("*").order("created_at");
    if (error) throw error;
    if (!profiles?.length) return res.json({ data: [] });

    const userIds = profiles.map(p => p.user_id);
    const { data: users } = await supabase.from("users").select("*").in("id", userIds);
    const userMap = {}; (users || []).forEach(u => { userMap[u.id] = u; });

    const { data: auths } = await supabase.from("operator_authorizations").select("*").in("operator_profile_id", profiles.map(p => p.id));
    const authMap = {};
    (auths || []).forEach(a => { if (!authMap[a.operator_profile_id]) authMap[a.operator_profile_id] = []; authMap[a.operator_profile_id].push(a); });

    const data = profiles.map(p => ({
      id: p.id,
      user: userMap[p.user_id] ? { id: userMap[p.user_id].id, display_name: userMap[p.user_id].display_name, preferred_language: userMap[p.user_id].preferred_language } : null,
      trained_at: p.trained_at,
      training_expires_at: p.training_expires_at,
      certified_inspector: p.certified_inspector,
      employment_status: p.employment_status,
      authorizations: authMap[p.id] || [],
    }));

    const q = (req.query.q || "").toString().toLowerCase();
    const filtered = q ? data.filter(d => d.user?.display_name?.toLowerCase().includes(q)) : data;
    res.json({ data: filtered });
  } catch (e) { next(e); }
});

// Get single operator
operatorsRouter.get("/:operator_id", requireAuth, requirePermission("operator.read"), async (req, res, next) => {
  try {
    const { data: p, error } = await supabase.from("operator_profiles").select("*").eq("id", req.params.operator_id).single();
    if (error) throw error;
    const [{ data: user }, { data: auths }] = await Promise.all([
      supabase.from("users").select("*").eq("id", p.user_id).single(),
      supabase.from("operator_authorizations").select("*").eq("operator_profile_id", p.id),
    ]);
    res.json({ data: { ...p, user, authorizations: auths || [] } });
  } catch (e) { next(e); }
});

// Create operator (user + profile)
operatorsRouter.post("/", requireAuth, requirePermission("operator.manage"), async (req, res, next) => {
  try {
    const { employee_code, username, display_name, preferred_language, trained_at, training_expires_at, evaluator_user_id, site_id } = req.body;
    const { data: site } = await supabase.from("sites").select("organization_id").eq("id", site_id).single();
    if (!site) return res.status(400).json({ error: { code: "invalid_site", message: "Site required" } });

    const { data: user, error: ue } = await supabase.from("users").insert({
      organization_id: site.organization_id, employee_code, username,
      display_name, preferred_language: preferred_language || "en",
    }).select().single();
    if (ue) throw ue;

    const { data: profile, error: pe } = await supabase.from("operator_profiles").insert({
      user_id: user.id, trained_at, training_expires_at, evaluator_user_id,
    }).select().single();
    if (pe) throw pe;

    await supabase.from("user_role_grants").insert({
      user_id: user.id, organization_id: site.organization_id, site_id,
      role_code: "operator_warehouse",
    });

    res.status(201).json({ data: { ...profile, user } });
  } catch (e) { next(e); }
});

// Update operator
operatorsRouter.patch("/:operator_id", requireAuth, requirePermission("operator.manage"), async (req, res, next) => {
  try {
    const { display_name, preferred_language, trained_at, training_expires_at, certified_inspector, evaluator_user_id, employment_status } = req.body;
    const { data: profile } = await supabase.from("operator_profiles").select("user_id").eq("id", req.params.operator_id).single();
    if (!profile) return res.status(404).json({ error: { code: "not_found", message: "Operator not found" } });

    if (display_name || preferred_language) {
      await supabase.from("users").update({
        ...(display_name && { display_name }),
        ...(preferred_language && { preferred_language }),
        updated_at: new Date().toISOString(),
      }).eq("id", profile.user_id);
    }

    const profilePatch = {};
    if (trained_at !== undefined) profilePatch.trained_at = trained_at;
    if (training_expires_at !== undefined) profilePatch.training_expires_at = training_expires_at;
    if (certified_inspector !== undefined) profilePatch.certified_inspector = certified_inspector;
    if (evaluator_user_id !== undefined) profilePatch.evaluator_user_id = evaluator_user_id;
    if (employment_status !== undefined) profilePatch.employment_status = employment_status;
    if (Object.keys(profilePatch).length > 0) {
      profilePatch.updated_at = new Date().toISOString();
      await supabase.from("operator_profiles").update(profilePatch).eq("id", req.params.operator_id);
    }
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

// List authorizations
operatorsRouter.get("/:operator_id/authorizations", requireAuth, requirePermission("operator.read"), async (req, res, next) => {
  try {
    const { data, error } = await supabase.from("operator_authorizations")
      .select("*").eq("operator_profile_id", req.params.operator_id);
    if (error) throw error;
    res.json({ data });
  } catch (e) { next(e); }
});

// Upsert authorization
operatorsRouter.post("/:operator_id/authorizations", requireAuth, requirePermission("operator.manage"), async (req, res, next) => {
  try {
    const { asset_type_code, trained_at, expires_at, evaluator_user_id, status } = req.body;
    const { data: existing } = await supabase.from("operator_authorizations")
      .select("id").eq("operator_profile_id", req.params.operator_id).eq("asset_type_code", asset_type_code).maybeSingle();
    if (existing) {
      const { data, error } = await supabase.from("operator_authorizations").update({
        trained_at, expires_at, evaluator_user_id, status, updated_at: new Date().toISOString(),
      }).eq("id", existing.id).select().single();
      if (error) throw error;
      return res.status(200).json({ data });
    }
    const { data, error } = await supabase.from("operator_authorizations").insert({
      operator_profile_id: req.params.operator_id, asset_type_code, trained_at, expires_at, evaluator_user_id,
      status: status || "authorized",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ data });
  } catch (e) { next(e); }
});
