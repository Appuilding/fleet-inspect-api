# Feeding Westchester Fleet Inspect — API Server

REST API server that implements the Fleet Inspect OpenAPI v3 contract. Serves the React prototype, future Android app, and future WinUI 3 desktop app.

## Architecture

```
Android app ─┐
Desktop app ─┼─> Fleet Inspect API (Node.js + Express) ─> Supabase (PostgreSQL + Auth)
Web prototype ┘
```

## What This Does

- **19 endpoint groups** matching the OpenAPI spec
- **Supabase Auth integration** — JWT-based authentication on every endpoint
- **Role-based permissions** — 7 roles × 22 permissions enforced server-side
- **Business logic** for inspections (critical fail → auto-defect → OOS lock → work order → notifications)
- **Idempotent sync** via `x-client-event-id` headers
- **State machines** for safety cases, temperature holds, and work orders
- **Audit trail** for every mutation

## Environment Variables (3 required)

Set these in Render → your service → Environment:

- `SUPABASE_URL` — `https://uzvjktwqxyppflnvtsrk.supabase.co`
- `SUPABASE_SERVICE_KEY` — service_role key (SECRET, server-side only)
- `SUPABASE_ANON_KEY` — anon public key (used for JWT verification during auth)

## Endpoints

All mounted at `/api/v1`. **Every endpoint requires a Supabase Auth JWT** via `Authorization: Bearer <token>` header except `/auth/login` and `/auth/refresh`.

### Auth
- `POST /auth/login` — email + password → access_token + refresh_token + Me context
- `POST /auth/refresh` — refresh_token → new access_token
- `POST /auth/logout` — invalidate session
- `GET /auth/me` — current user + permissions

### Domain
- `GET /me` — current user context
- `GET /sites` · `/sites/:id` · `/sites/:id/policy`
- `GET /assets` · `POST /assets` · `PATCH /assets/:id` · `POST /assets/resolve-tag`
- `GET /operators` · `POST /operators` · `PATCH /operators/:id`
- `GET /checklists/resolve`
- `POST /sessions` · `POST /sessions/:id/handoff`
- `POST /inspections` · `GET /inspections/:id` · `POST /inspections/:id/amendments`
- `POST /returns`
- `POST /safety-observations` · `POST /safety-observations/:id/actions`
- `GET /defects` · `GET /work-orders` · `POST /work-orders` · `POST /work-orders/:id/verify`
- `GET /temperature-holds` · `POST /temperature-holds/:id/approve|reject`
- `GET /reports/dashboard` · `/compliance` · `/fleet-health` · `/operators` · `/alerts`
- `GET /history/events`
- `GET /coaching/me` · `/coaching/operators` · `POST /coaching/operators/:id/notes`
- `GET /notifications` · `POST /notifications/:id/read`
- `GET /help/articles`
- `POST /sync/push` · `GET /sync/pull`

## Permissions

Each endpoint enforces role-based permissions via `requirePermission(...)` middleware.

| Role | Example permissions |
|---|---|
| `operator_warehouse`, `driver_delivery` | `inspection.create`, `session.start`, `session.return`, `safety.create`, `coaching.read_self` |
| `supervisor` | +`approval.temperature`, `approval.return_to_service`, `safety.manage`, `reports.read` |
| `safety_manager` | `safety.manage`, `reports.read` |
| `fleet_admin` | +`fleet.manage`, `operator.manage`, `templates.manage` |
| `org_admin` | all permissions |

See `src/auth.js` for middleware; see `role_permissions` table for complete mappings.

## Testing Login

```bash
curl -X POST https://fleet-inspect-api.onrender.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ykesse@feedingwestchester.org","password":"Finspect2026!"}'
```

Returns:
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "expires_in_sec": 3600,
    "me": { "user": {...}, "role_grants": [...], "permissions": [...], "sites": [...] }
  }
}
```

Use the access_token:
```bash
curl https://fleet-inspect-api.onrender.com/api/v1/me \
  -H "Authorization: Bearer eyJ..."
```

## Free Tier Notes

Render free tier: 750 hours/month. Cold start ~30s after 15 min of inactivity.
