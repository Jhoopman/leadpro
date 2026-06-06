---
name: run-leadpro
description: Run, start, launch, smoke-test, or verify the LeadPro Express server. Use when asked to start the app, run the server, check endpoints, screenshot the UI, or confirm a fix is live locally.
---

# run-leadpro

LeadPro is a Node.js/Express server (entry: `server.js`, default port 3000).
The agent path is a curl-based smoke script at `.claude/skills/run-leadpro/smoke.sh`.
For visual inspection of the web UI use `chromium-cli` against the running server.

## Prerequisites

Node ≥ 18 and npm already installed. All dependencies are in `node_modules/`.
To reinstall from scratch:
```bash
npm install
```

Environment variables are loaded from `.env` via dotenv. Required vars:
`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`).
Other vars (`RESEND_API_KEY`, `STRIPE_*`, `TWILIO_*`) are optional — server starts without them.

## Run (agent path) — smoke script

The smoke script starts the server if nothing is on port 3000, runs 10 curl checks,
and exits 0 (all pass) or 1 (any fail). Run from the project root:

```bash
bash .claude/skills/run-leadpro/smoke.sh
```

Checks performed:
- `GET /health` → 200, JSON `{ok:true}`
- `GET /` → 200 (marketing page)
- `GET /config` → 200, JSON with `supabaseUrl`
- `GET /widget.js` → 200
- `GET /widget-chat.html` → 200
- `GET /api/admin/anthropic-test?token=leadpro-diag-2024` → 200, shows Anthropic key status
- `POST /widget-api` with marketing widget payload → valid JSON response
- `POST /api` (no token) → 401

Override port: `PORT=4000 bash .claude/skills/run-leadpro/smoke.sh`

### Anthropic key status

The diagnostic endpoint reveals the key prefix and the raw Anthropic HTTP status:
```bash
curl -s "http://localhost:3000/api/admin/anthropic-test?token=leadpro-diag-2024"
# 200 = key valid; 401 = key invalid/revoked (fix in Render env, not in code)
```

## Run (human path)

```bash
node server.js
# or: npm start
```

Server prints startup status and listens on PORT (default 3000).
Ctrl-C to stop. Useless headless — open http://localhost:3000 in a browser.

## Key routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | Marketing landing page |
| GET | `/app` | Dashboard SPA (`LeadPro_Full_App.html`) |
| GET | `/health` | Liveness probe |
| GET | `/config` | Public Supabase keys for the browser |
| GET | `/widget-chat.html?id=<widgetId>` | Embedded chat iframe |
| GET | `/widget.js` | Widget embed script |
| POST | `/widget-api` | AI chat proxy (no auth required) |
| POST | `/api` | Raw Claude proxy (auth required) |
| GET | `/api/admin/anthropic-test?token=leadpro-diag-2024` | Live Anthropic diagnostic |

## Gotchas

- **Duplicate `ANTHROPIC_API_KEY` in `.env`**: dotenv uses the last occurrence. If the local key is invalid (401 from Anthropic), that's a `.env` issue — the Render env var is the source of truth for production.
- **Port 3000 already in use**: the smoke script detects this and skips the server launch. If you need a fresh server: `kill $(lsof -ti:3000)` then re-run.
- **Supabase `your_key` placeholder**: the `.env` has placeholder values for `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY`. The server starts (truthy string passes the check), but Supabase queries will fail. Real keys are in Render environment only.
- **`POST /api` vs `GET /api`**: only POST is wired; GET returns 404. The smoke script explicitly uses `-X POST` to test the auth guard.
- **`set -e` + arithmetic**: `((VAR++))` exits with 1 when VAR is 0 — use `VAR=$((VAR + 1))` in smoke scripts under `set -euo pipefail`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `EADDRINUSE :::3000` | `kill $(lsof -ti:3000)` |
| `Missing required env var: ANTHROPIC_API_KEY` | `.env` file missing or first line blank; ensure at least one `ANTHROPIC_API_KEY=sk-ant-...` line exists |
| Widget shows "Connection error" | Hit the diagnostic endpoint — `anthropicStatus: 401` means the API key on Render is invalid/revoked |
| Server exits immediately after startup | `config/index.js` calls `process.exit(1)` for missing required vars — check stdout for the `❌ Missing required env var` line |
