import { createClient } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";

// Anon client for verifying JWTs (cheaper than service-role for reads)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const authClient = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

// Cache per-user context for 60s to avoid hammering the DB
const contextCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function cacheGet(userId) {
  const hit = contextCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.value;
  contextCache.delete(userId);
  return null;
}
function cacheSet(userId, value) {
  contextCache.set(userId, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Verify token → load internal user row → load role grants + permissions
async function loadUserContext(authToken) {
  if (!authClient) throw new Error("SUPABASE_ANON_KEY not configured");

  const { data: { user: authUser }, error } = await authClient.auth.getUser(authToken);
  if (error || !authUser) return null;

  const cached = cacheGet(authUser.id);
  if (cached) return cached;

  const { data: dbUser } = await supabase.from("users")
    .select("id, display_name, preferred_language, organization_id, employee_code, email, active")
    .eq("supabase_auth_id", authUser.id).maybeSingle();
  if (!dbUser || !dbUser.active) return null;

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

  const context = {
    authId: authUser.id,
    user: dbUser,
    roleGrants: grants || [],
    permissions,
    roleCodes,
    siteIds: [...new Set((grants || []).map(g => g.site_id).filter(Boolean))],
  };
  cacheSet(authUser.id, context);
  return context;
}

// Middleware: require a valid Supabase JWT.
// Attaches req.auth = { user, roleGrants, permissions, ... }
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: { code: "no_token", message: "Authorization header required" } });

    const context = await loadUserContext(token);
    if (!context) return res.status(401).json({ error: { code: "invalid_token", message: "Invalid or expired token" } });

    req.auth = context;
    next();
  } catch (e) { next(e); }
}

// Middleware factory: require a specific permission
// Usage: router.post("/assets", requireAuth, requirePermission("fleet.manage"), handler)
export function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: { code: "no_auth", message: "Authentication required" } });
    const has = codes.some(c => req.auth.permissions.includes(c));
    if (!has) return res.status(403).json({
      error: { code: "forbidden", message: `Requires one of: ${codes.join(", ")}`, your_permissions: req.auth.permissions },
    });
    next();
  };
}

// Helper: clear cache for a user (call after role changes)
export function invalidateUserCache(authId) {
  contextCache.delete(authId);
}
