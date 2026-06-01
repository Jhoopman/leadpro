# CLAUDE.md — LeadPro

> Project memory for Claude Code. Loaded every session. Keep under ~200 lines. Update as conventions change.

## What LeadPro is
AI scheduling + lead management SaaS for home-service contractors. Core value: AI voice receptionist (Vapi), missed-call text-back, AI chat widget, lead follow-up automation. Pricing: Starter $97/mo, Pro $197/mo. Solo founder.

## Stack
- **Backend:** Node.js / Express
- **DB:** Supabase (Postgres) — project `ajfdwtlydwqwyvqdeilv`
- **Payments:** Stripe (live mode; live ≠ test — separate products/prices/webhooks)
- **Voice:** Vapi (AI phone agent)
- **SMS:** Twilio (A2P 10DLC)
- **Email:** Resend (verified domain; sender `alerts@useleadpro.net`)
- **Host:** Render — **deploys from `origin/main`**
- **Frontend:** single-page app `LeadPro_Full_App.html` (auth + dashboard + paywall). Marketing site `index.html`. Widget `widget.js` / `widget-chat.html`.
- **Domains:** `useleadpro.net` (marketing), `app.useleadpro.net` (app)

## Architecture / data flow
- **Inbound call** → Vapi answers → end-of-call webhook → `routes/vapi.js`:
  - Resolves contractor by `vapi_phone_number_id` → fallback `vapi_assistant_id`. **If neither is set on the contractor row, the call resolves to null and the ENTIRE pipeline silently skips** (no lead, no email, no SMS, no text-back).
  - On success: insert lead → contractor alert SMS → alert email → caller text-back.
  - **Idempotency:** Vapi delivers each end-of-call webhook ~15–30×. A top-level gate inserts `vapi_endofcall_${callId}` into `processed_webhook_events` (unique constraint); duplicates log `end-of-call duplicate — skipping` and exit early. Same dedup pattern lives in `billing.js`.
- **Billing:** Stripe checkout → `routes/billing.js` (verify-then-create handles stale `stripe_customer_id`).
- **Email:** `services/email.js` sends via Resend. MUST surface non-2xx responses (log + reject) — never swallow.
- **SMS:** Twilio. Text-back sent from the contractor's `twilio_phone`. Opt-out via `leads.sms_opt_out` flag + Twilio STOP/START keywords.

## Provisioning — read this before touching onboarding
A contractor only works if these fields are set on its row: `vapi_phone_number_id`, `vapi_assistant_id`, `twilio_phone`, `email`, `widget_id`, `widget_domain`.
**Signup does NOT auto-provision these yet.** `POST /api/vapi/assistant` exists but is never invoked (dead code). New contractors are wired manually (see the Onboarding SOP in Notion) until provisioning is automated.

## How to work in this repo (prompting rules)
- **Investigate before changing.** Read the relevant file(s) and report what's actually there BEFORE editing. Name the files/functions you'll touch.
- **Diff-only output.** No full-file rewrites. Match existing naming and patterns.
- **Never remove what's there.** Build on existing markup/logic; don't regress working code.
- **Verify on the live deployed page** before claiming something is fixed. Source ≠ deployed.
- **Surface errors, never swallow them.** Log non-2xx; reject so callers' catch fires.
- **Name served files explicitly** — don't rely on `readdirSync` ordering (it has served the wrong file before).
- **E.164 everywhere** for phone numbers (`^\+[1-9]\d{1,14}$`); keep consistent between Twilio and the `contractors`/`leads` tables.
- A fix isn't live until committed + pushed (Render deploys from `origin/main`). **If behavior doesn't change after a "fix," run `git status` first** — it may be uncommitted.

## Model use
Default **Sonnet 4.6**. Escalate to **Opus 4.8** for multi-file debugging, architecture, security-sensitive code, or after 2+ failed attempts on Sonnet.

## Don't
- Don't commit credentials/secrets or write malware.
- Don't programmatically provision a Twilio number for SMS without confirming it's attached to an **approved** A2P campaign (error `30034` = number not registered to an approved campaign).
- Don't mix audiences in one A2P campaign (contractor opt-in vs end-customer opt-in) — that's what got the campaign rejected.

## Useful endpoints (tokens live in Render env, not here)
- Stripe diagnostics: `app.useleadpro.net/api/admin/stripe-config` (with diag token)
- Supabase config check: `/config`
