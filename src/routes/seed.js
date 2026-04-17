import { Router } from "express";
import { supabase } from "../supabase.js";

export const seedRouter = Router();

const USERS = [
  { user_id: "c0000000-0000-0000-0000-000000000001", email: "ykesse+ryan@feedingwestchester.org",   name: "Ryan S." },
  { user_id: "c0000000-0000-0000-0000-000000000002", email: "ykesse+oreidy@feedingwestchester.org", name: "Oreidy C." },
  { user_id: "c0000000-0000-0000-0000-000000000003", email: "ykesse+keith@feedingwestchester.org",  name: "Keith B." },
  { user_id: "c0000000-0000-0000-0000-000000000004", email: "ykesse@feedingwestchester.org",        name: "Yaw K." },
  { user_id: "d0000000-0000-0000-0000-000000000001", email: "ykesse+carlos@feedingwestchester.org", name: "Carlos M." },
  { user_id: "d0000000-0000-0000-0000-000000000002", email: "ykesse+jose@feedingwestchester.org",   name: "Jose R." },
  { user_id: "d0000000-0000-0000-0000-000000000003", email: "ykesse+maria@feedingwestchester.org",  name: "Maria L." },
  { user_id: "d0000000-0000-0000-0000-000000000004", email: "ykesse+david@feedingwestchester.org",  name: "David P." },
  { user_id: "d0000000-0000-0000-0000-000000000005", email: "ykesse+ana@feedingwestchester.org",    name: "Ana S." },
  { user_id: "d0000000-0000-0000-0000-000000000006", email: "ykesse+miguel@feedingwestchester.org", name: "Miguel T." },
];

const PASSWORD = "Finspect2026!";
const SEED_SECRET = process.env.SEED_SECRET || "fw-seed-6f4a2c8e";

// POST /seed/auth?secret=fw-seed-6f4a2c8e
// One-time seed of Supabase Auth accounts linked to public.users rows.
// Protected by a secret query param so it can't be called anonymously.
seedRouter.post("/auth", async (req, res) => {
  const provided = req.query.secret || req.headers["x-seed-secret"];
  if (provided !== SEED_SECRET) {
    return res.status(403).json({ error: { code: "forbidden", message: "Invalid seed secret" } });
  }

  const results = [];
  try {
    // Fetch all existing auth users once
    const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (listErr) throw listErr;
    const existingByEmail = {};
    (list?.users || []).forEach(u => { if (u.email) existingByEmail[u.email] = u.id; });

    for (const u of USERS) {
      try {
        let authId = existingByEmail[u.email];
        let action;

        if (authId) {
          action = "relinked";
          // Reset password to the known password in case we need to recover
          await supabase.auth.admin.updateUserById(authId, { password: PASSWORD, email_confirm: true });
        } else {
          const { data, error } = await supabase.auth.admin.createUser({
            email: u.email,
            password: PASSWORD,
            email_confirm: true,
            user_metadata: { display_name: u.name, fleet_user_id: u.user_id },
          });
          if (error) throw error;
          authId = data.user.id;
          action = "created";
        }

        // Link the public.users row
        const { error: linkErr } = await supabase.from("users").update({
          supabase_auth_id: authId,
          email: u.email,
          updated_at: new Date().toISOString(),
        }).eq("id", u.user_id);
        if (linkErr) throw linkErr;

        results.push({ name: u.name, email: u.email, user_id: u.user_id, auth_id: authId, action });
      } catch (e) {
        results.push({ name: u.name, email: u.email, user_id: u.user_id, error: e.message });
      }
    }

    const success = results.filter(r => !r.error).length;
    const failed = results.filter(r => r.error).length;
    res.json({
      data: {
        summary: `${success} seeded, ${failed} failed`,
        password_for_all: PASSWORD,
        results,
      },
    });
  } catch (e) {
    res.status(500).json({ error: { code: "seed_failed", message: e.message } });
  }
});
