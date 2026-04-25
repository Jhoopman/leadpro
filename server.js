// server.js — LeadPro entry point
// This file only wires things together. No business logic lives here.
// Target: stay under 100 lines. If it grows, something is in the wrong place.

require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const cfg = require('./config');

// ── APP ───────────────────────────────────────────────────────────────────────

const app = express();

// Raw body capture for Stripe webhook signature verification (must come first)
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));

// JSON body parser for all other routes
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────────
// TODO: tighten origin list when you have a stable domain
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── STATIC FILES ──────────────────────────────────────────────────────────────

app.get('/widget.js',         (_, res) => res.sendFile(path.join(__dirname, 'widget.js')));
app.get('/widget-chat.html',  (_, res) => res.sendFile(path.join(__dirname, 'widget-chat.html')));
app.get('/manifest.json',     (_, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/service-worker.js', (_, res) => {
  res.setHeader('Content-Type',          'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'service-worker.js'));
});

// ── CONFIG ENDPOINT ───────────────────────────────────────────────────────────
// Exposes public Supabase keys to the browser — never expose service key here

app.get('/config', (_, res) => res.json({
  supabaseUrl:     cfg.supabaseUrl,
  supabaseAnonKey: cfg.supabaseAnonKey,
  configured:      !!(cfg.supabaseUrl && cfg.supabaseAnonKey),
}));

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// GET /api/health/db — verifies PostgREST can read the three core tables.
// Pass Authorization: Bearer <token> to also verify the caller has a contractors row.
// Hit from browser: https://app.useleadpro.net/api/health/db
app.get('/api/health/db', async (req, res) => {
  const supabase = require('./services/supabase');
  const results  = {};

  for (const table of ['contractors', 'leads', 'appointments']) {
    try {
      const { data, error } = await supabase.from(table).select('id').limit(1);
      results[table] = error
        ? { ok: false, error: error.message }
        : { ok: true, row_count: data.length };
    } catch (e) {
      results[table] = { ok: false, error: e.message };
    }
  }

  // If a token is supplied, also verify the caller has a contractors row
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) {
    try {
      const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
      if (authErr || !user) {
        results.caller = { ok: false, error: 'token invalid or expired' };
      } else {
        const { data: row } = await supabase
          .from('contractors').select('id, email, plan, plan_status').eq('id', user.id).single();
        results.caller = row
          ? { ok: true, id: row.id, email: row.email, plan: row.plan, plan_status: row.plan_status }
          : { ok: false, error: 'no contractors row for this user' };
      }
    } catch (e) {
      results.caller = { ok: false, error: e.message };
    }
  }

  const allOk = Object.values(results).every(r => r.ok);
  res.status(allOk ? 200 : 503).json({ ok: allOk, ts: new Date().toISOString(), ...results });
});

// ── HTML ROUTES ───────────────────────────────────────────────────────────────

// Auth page — publicly accessible (no token needed)
app.get('/auth',   (_, res) => res.sendFile(path.join(__dirname, 'auth.html')));
// Signup page — serves auth.html; JS detects /signup path and opens the signup tab
app.get('/signup', (_, res) => res.sendFile(path.join(__dirname, 'auth.html')));

// Widget install guide — publicly served, JS inside handles auth redirect
app.get('/install', (_, res) => res.sendFile(path.join(__dirname, 'install.html')));

// Dashboard — both / and /app serve the main PWA dashboard.
// Named explicitly so readdir order on Linux never picks the wrong file.
app.get(['/', '/app'], (_, res) => res.sendFile(path.join(__dirname, 'LeadPro_Full_App.html')));
app.get('/prospector', (_, res) => res.sendFile(path.join(__dirname, 'prospector.html')));
app.get('/outreach',   (_, res) => res.sendFile(path.join(__dirname, 'outreach-sequences.html')));
app.get('/launch',     (_, res) => res.sendFile(path.join(__dirname, 'launch-plan.html')));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
// Applied BEFORE route modules so every matching request is gated.
// /widget-api, /api/availability, /api/book-appointment intentionally left open (widget use).

const { requireAuth } = require('./routes/auth');
const { requirePlan }  = require('./routes/middleware/planGate');

// Auth gates — verify Bearer token, attach req.contractor
app.use(['/send-confirmation', '/scrape', '/create-checkout-session', '/billing-portal'], requireAuth);
app.post('/api',             requireAuth);
app.use('/api/agent-config', requireAuth);
app.use('/api/test-agent',   requireAuth);
app.post('/auth/google/disconnect', requireAuth);
app.use('/api/prospector',   requireAuth);   // prospector wasn't previously auth-gated

// Plan gates — always after requireAuth (reads req.contractor, no extra DB calls)
app.post('/api',              requirePlan('starter'));   // /api chat proxy → Starter+
app.use('/send-confirmation', requirePlan('starter'));
app.use('/calendar',          requirePlan('starter'));
app.use('/billing-portal',    requirePlan('starter'));
app.use('/api/prospector',    requirePlan('pro'));

// ── ROUTE MODULES ─────────────────────────────────────────────────────────────

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/agent'));
app.use('/', require('./routes/billing'));
app.use('/', require('./routes/calendar'));
app.use('/', require('./routes/prospector'));
app.use('/', require('./routes/contractors'));
app.use('/', require('./routes/twilio').router);
app.use('/', require('./routes/vapi'));

// ── ERROR HANDLING ────────────────────────────────────────────────────────────

const { notFound, globalError } = require('./middleware/errorHandler');
app.use(notFound);
app.use(globalError);

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(cfg.port, () => {
  console.log('\n✅ LeadPro server running on port', cfg.port);
  console.log('✅ Supabase configured');
  console.log(cfg.stripe.secretKey     ? '✅ Stripe configured'          : '⚠️  Stripe not configured');
  console.log(cfg.google.placesApiKey  ? '✅ Google Places configured'   : '⚠️  Google Places not configured');
  console.log(cfg.google.clientId      ? '✅ Google Calendar configured' : '⚠️  Google Calendar not configured');
  console.log(cfg.resendApiKey         ? '✅ Resend email configured'    : '⚠️  Resend not configured');
  console.log('');
});
