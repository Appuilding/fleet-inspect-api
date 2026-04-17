# Feeding Westchester Fleet Inspect — API Server

REST API server that implements the Fleet Inspect OpenAPI v3 contract. Serves the React prototype, future Android app, and future WinUI 3 desktop app.

## What This Does

- **18 endpoint groups** matching the OpenAPI spec
- **Business logic** for inspections (critical fail → auto-defect → OOS lock → work order → notifications)
- **Idempotent sync** via `x-client-event-id` headers
- **State machines** for safety cases, temperature holds, and work orders
- **Audit trail** for every mutation
- **Bilingual-ready** (templates carry both `label_en` and `label_es`)

## Architecture

```
Android app ─┐
Desktop app ─┼─> Fleet Inspect API (Node.js + Express) ─> Supabase (PostgreSQL)
Web prototype ┘
```

The API server uses Supabase's **service-role key** to bypass RLS and enforce authorization in the application layer instead. This gives us transaction control, state machines, and audit events that PostgREST alone can't provide.

## Local Development

```bash
npm install
export SUPABASE_URL="https://uzvjktwqxyppflnvtsrk.supabase.co"
export SUPABASE_SERVICE_KEY="<service_role_key>"
npm start
```

Open http://localhost:3000/healthz — should return `{ "status": "ok" }`.

## Deploy to Render (Free Tier)

### Step 1 — Push to GitHub

1. Go to **https://github.com/new**
2. Repo name: `fleet-inspect-api`
3. Keep it **Public** (so Render free tier can deploy it — Render supports private repos only on paid plans)
4. Click **Create repository**
5. On the next page, find the command list under "...or push an existing repository from the command line" — but we won't use the command line. Instead:
6. Click **uploading an existing file** (the link in the middle of the page)
7. Drag the entire contents of the `api-server` folder into the browser
8. Scroll down, commit message: `Initial API server`
9. Click **Commit changes**

### Step 2 — Get Your Supabase Service Role Key

1. Open your Supabase dashboard → **Settings** (gear icon, bottom left)
2. Click **API Keys** in the left menu
3. Click the **Legacy anon, service_role API keys** tab
4. Find the **service_role** key (it says "SECRET — server-side use only")
5. Click the eye icon to reveal it, then copy the full key (starts with `eyJ...`)
6. **Never commit this key to GitHub** — it bypasses all security. We're only pasting it into Render's environment variables.

### Step 3 — Deploy on Render

1. Go to **https://render.com** and log in
2. Click **+ New** (top right) → **Web Service**
3. Click **Connect GitHub** if you haven't yet, then authorize Render
4. Find the `fleet-inspect-api` repo and click **Connect**
5. Fill in the form:
   - **Name:** `fleet-inspect-api`
   - **Region:** Ohio (closest to NY)
   - **Branch:** `main`
   - **Root Directory:** (leave empty)
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** **Free**
6. Scroll down to **Environment Variables** and click **Add Environment Variable**:
   - Key: `SUPABASE_URL` — Value: `https://uzvjktwqxyppflnvtsrk.supabase.co`
   - Key: `SUPABASE_SERVICE_KEY` — Value: paste the service_role key from Step 2
7. Click **Create Web Service**
8. Render builds and deploys. Takes ~2 minutes.
9. When done, you'll see a URL at the top like `https://fleet-inspect-api-xyz.onrender.com`

### Step 4 — Verify

Open `https://<your-render-url>/healthz` in a browser. You should see:
```json
{ "status": "ok" }
```

Open `https://<your-render-url>/api/v1/assets` — you should see all 34 vehicles.

## Free Tier Notes

- Render free tier: **750 hours/month** (enough for 1 always-on service)
- **Cold start:** service sleeps after 15 minutes of inactivity, wakes on next request (~30 seconds)
- When operators are actively using the app, it stays warm. First request of the day takes 30 seconds.
- For production use with multiple sites, upgrade to the **Starter** plan ($7/month) for zero cold starts.

## Endpoints

All mounted at `/api/v1`:

- `GET /me` — current user context
- `GET /sites` — visible sites
- `GET /assets` · `POST /assets` · `PATCH /assets/:id` — fleet CRUD
- `POST /assets/resolve-tag` — QR/NFC lookup
- `GET /operators` · `POST /operators` · `PATCH /operators/:id` — operator management
- `GET /checklists/resolve` — active checklist template
- `POST /sessions` — sign out equipment
- `POST /sessions/:id/handoff` — shift change
- `POST /inspections` — submit inspection (with full business logic)
- `POST /returns` — return equipment
- `POST /safety-observations` · `POST /safety-observations/:id/actions` — safety workflow
- `GET /defects` — defect list
- `POST /work-orders` · `POST /work-orders/:id/verify` — maintenance workflow
- `POST /temperature-holds/:id/approve|reject` — cold chain approvals
- `GET /reports/dashboard` · `/compliance` · `/fleet-health` · `/operators` · `/alerts`
- `GET /history/events` — unified event stream
- `GET /coaching/me` · `/coaching/operators` · `POST /coaching/operators/:id/notes`
- `GET /notifications` · `POST /notifications/:id/read`
- `GET /help/articles`
- `POST /sync/push` · `GET /sync/pull` — offline sync

## Next Steps After Deployment

1. Wire the web prototype to call the Render URL instead of Supabase directly
2. Build the Android app and point it at the same API
3. Build the WinUI 3 desktop app and point it at the same API
