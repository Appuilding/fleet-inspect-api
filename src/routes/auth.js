import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import { requireAuth, invalidateUserCache } from "../auth.js";

export const authRouter = Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const authClient = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

// POST /auth/login — email + password
authRouter.post("/login", async (req, res, next) => {
  try {
    if (!authClient) return res.status(500).json({ error: { code: "auth_not_configured", message: "SUPABASE_ANON_KEY missing on server" } });
    const { email, password, device } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: { code: "missing_credentials", message: "email and password required" } });

    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) return res.status(401).json({ error: { code: "invalid_credentials", message: "Email or password incorrect" } });

    // Look up the internal user + org
    const { data: dbUser } = await supabase.from("users")
      .select("id, display_name, preferred_language, organization_id")
      .eq("supabase_auth_id", data.user.id).maybeSingle();

    if (!dbUser) return res.status(403).json({ error: { code: "no_profile", message: "Login succeeded but no Fleet Inspect profile is linked to this email" } });

    // Register the device if provided
    if (device?.device_external_id && device?.platform) {
      try {
        await supabase.from("devices").upsert({
          organization_id: dbUser.organization_id, user_id: dbUser.id,
          platform: device.platform, device_external_id: device.device_external_id,
          device_model: device.device_model, app_version: device.app_version, build_no: device.build_no,
          last_seen_at: new Date().toISOString(),
        }, { onConflict: "organization_id,platform,device_external_id" });
      } catch (e) { /* non-fatal */ }
    }

    // Load role grants + permissions for the Me payload
    const { data: grants } = await supabase.from("user_role_grants")
      .select("role_code, site_id, starts_at, ends_at")
      .eq("user_id", dbUser.id).eq("active", true);
    const roleCodes = [...new Set((grants || []).map(g => g.role_code))];
    let permissions = [];
    if (roleCodes.length > 0) {
      const { data: rp } = await supabase.from("role_permissions")
        .select("permission_code").in("role_code", roleCodes);
      permissions = [...new Set((rp || []).map(p => p.permission_code))];
    }
    const { data: sites } = await supabase.from("sites").select("*").eq("active", true);

    res.json({
      data: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in_sec: data.session.expires_in,
        me: {
          user: { id: dbUser.id, display_name: dbUser.display_name, preferred_language: dbUser.preferred_language },
          role_grants: grants || [],
          permissions,
          sites: sites || [],
        },
      },
    });
  } catch (e) { next(e); }
});

// POST /auth/refresh — exchange a refresh token for a new access token
authRouter.post("/refresh", async (req, res, next) => {
  try {
    if (!authClient) return res.status(500).json({ error: { code: "auth_not_configured" } });
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: { code: "missing_token" } });
    const { data, error } = await authClient.auth.refreshSession({ refresh_token });
    if (error || !data?.session) return res.status(401).json({ error: { code: "invalid_refresh" } });
    res.json({
      data: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in_sec: data.session.expires_in,
      },
    });
  } catch (e) { next(e); }
});

// POST /auth/logout — invalidate session on the server
authRouter.post("/logout", requireAuth, async (req, res, next) => {
  try {
    invalidateUserCache(req.auth.authId);
    // Supabase tokens are stateless JWTs; true revocation happens client-side by discarding them.
    // For refresh tokens, the client can call supabase.auth.signOut() locally.
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
});

// GET /auth/me — convenience endpoint returning current user + permissions
authRouter.get("/me", requireAuth, async (req, res) => {
  const { data: sites } = await supabase.from("sites").select("*").eq("active", true);
  res.json({
    data: {
      user: { id: req.auth.user.id, display_name: req.auth.user.display_name, preferred_language: req.auth.user.preferred_language },
      role_grants: req.auth.roleGrants,
      permissions: req.auth.permissions,
      sites: sites || [],
    },
  });
});
