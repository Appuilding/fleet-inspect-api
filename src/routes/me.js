import { Router } from "express";
import { supabase } from "../supabase.js";

export const meRouter = Router();

// For now, accept a user_id in query/header since auth isn't wired yet
// Returns: user, role_grants, permissions, sites
meRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.headers["x-user-id"] || req.query.user_id;
    if (!userId) return res.status(401).json({ error: { code: "no_user", message: "x-user-id header required" } });

    const [{ data: user }, { data: grants }, { data: sites }] = await Promise.all([
      supabase.from("users").select("*").eq("id", userId).single(),
      supabase.from("user_role_grants").select("*").eq("user_id", userId).eq("active", true),
      supabase.from("sites").select("*").eq("active", true),
    ]);

    if (!user) return res.status(404).json({ error: { code: "not_found", message: "User not found" } });

    // Gather permissions from role grants
    const roleCodes = (grants || []).map(g => g.role_code);
    let permissions = [];
    if (roleCodes.length > 0) {
      const { data: rp } = await supabase.from("role_permissions").select("permission_code").in("role_code", roleCodes);
      permissions = [...new Set((rp || []).map(p => p.permission_code))];
    }

    res.json({
      data: {
        user: { id: user.id, display_name: user.display_name, preferred_language: user.preferred_language },
        role_grants: grants || [],
        permissions,
        sites: sites || [],
      },
    });
  } catch (e) { next(e); }
});
