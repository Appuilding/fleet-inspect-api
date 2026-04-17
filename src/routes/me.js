import { Router } from "express";
import { supabase } from "../supabase.js";
import { requireAuth } from "../auth.js";

export const meRouter = Router();

// GET /me — current user context (protected by JWT auth)
meRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const { data: sites } = await supabase.from("sites").select("*").eq("active", true);
    res.json({
      data: {
        user: {
          id: req.auth.user.id,
          display_name: req.auth.user.display_name,
          preferred_language: req.auth.user.preferred_language,
          email: req.auth.user.email,
          employee_code: req.auth.user.employee_code,
        },
        role_grants: req.auth.roleGrants,
        permissions: req.auth.permissions,
        sites: sites || [],
      },
    });
  } catch (e) { next(e); }
});
