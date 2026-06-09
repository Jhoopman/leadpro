// server.js — LeadPro entry point
// This file only wires things together. No business logic lives here.
// Target: stay under 100 lines. If it grows, something is in the wrong place.

require('./instrument.js');
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const cfg = require('./config');

// ── APP ───────────────────────────────────────────────────────────────────────

const app = express();

// Raw body capture for Stripe webhook signature verification (must come first)
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));

// Raw body capture for Twilio signature verification (urlencoded; must precede router mount)
app.use('/twilio', express.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }));

// JSON body parser for all other routes
app.use(express.json());

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────

app.use(require('./middleware/securityHeaders'));

// ── CORS ──────────────────────────────────────────────────────────────────────

const { corsMiddleware } = require('./middleware/cors');
app.use(corsMiddleware);

// ── SENSITIVE FILE BLOCK ──────────────────────────────────────────────────────
// Defense-in-depth: return 404 if anyone requests .env files directly.
// GoDaddy static hosting previously served these — add this at the reverse proxy layer too.
app.get(/^\/.env($|\.)/, (_, res) => res.status(404).end());

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

// GET /api/health — uptime check for UptimeRobot and load-balancer pings.
// Public (no auth). 200 = everything critical is working. 503 = something is broken.
// Silent on success to avoid flooding Render logs (hits 12×/hr forever).
app.all('/api/health', async (req, res) => {
  const supabase = require('./services/supabase');
  const checks = {
    server:            'ok',
    supabase:          'unknown',
    stripe_configured: 'unknown',
    twilio_configured: 'unknown',
  };

  try {
    const start = Date.now();
    const { error } = await supabase
      .from('contractors')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    if (error) throw error;
    checks.supabase            = 'ok';
    checks.supabase_latency_ms = Date.now() - start;
  } catch (err) {
    checks.supabase = 'error';
    console.error('[Health] Supabase check failed:', err.message);
  }

  checks.stripe_configured = cfg.stripe.secretKey                            ? 'ok' : 'missing';
  checks.twilio_configured = (cfg.twilio.accountSid && cfg.twilio.authToken) ? 'ok' : 'missing';

  const critical_failed =
    checks.supabase === 'error' ||
    (process.env.NODE_ENV === 'production' && checks.stripe_configured === 'missing');

  res.status(critical_failed ? 503 : 200).json({
    status:    critical_failed ? 'unhealthy' : 'healthy',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/health/db — diagnostic tool: verifies PostgREST can read the three core tables.
// Pass Authorization: Bearer <token> to also verify the caller has a contractors row.
// More detailed than /api/health; not intended for UptimeRobot (exposes schema/row details).
// Hit from browser: https://app.useleadpro.net/api/health/db
const { createLimiter: _rl } = require('./middleware/rateLimit');
const healthDbLimit = _rl({ maxRequests: 30, windowMs: 60_000 });
app.get('/api/health/db', healthDbLimit, async (req, res) => {
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

// Legal pages — publicly accessible
app.get('/privacy', (_, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms',   (_, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/text',    (_, res) => res.sendFile(path.join(__dirname, 'text.html')));
// SMS opt-in — public, no auth
app.use('/', require('./routes/sms-consent'));

// Marketing landing page
app.get('/',    (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
// PWA dashboard
app.get('/app', (_, res) => res.sendFile(path.join(__dirname, 'LeadPro_Full_App.html')));
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

app.use('/', require('./routes/contact'));
app.use('/', require('./routes/demo'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/agent'));
app.use('/', require('./routes/billing'));
app.use('/', require('./routes/calendar'));
app.use('/', require('./routes/prospector'));
app.use('/', require('./routes/contractors'));
app.use('/', require('./routes/twilio').router);
app.use('/', require('./routes/vapi'));
app.use('/', require('./routes/consent'));

// ── Demo call trigger ──────────────────────────────────────────
const _demoCallLimit = _rl({ maxRequests: 3, windowMs: 60 * 60 * 1000, message: 'Too many demo requests — try again in an hour.' });
const _demoPhoneExpiry = new Map(); // phone → expiresAt (in-memory dedup, single instance)
const _E164 = /^\+1[2-9]\d{9}$/;

app.post('/api/demo-call', _demoCallLimit, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  // Sanitize — digits only, then format as E.164
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  const formattedPhone = '+1' + digits.slice(-10);

  if (!_E164.test(formattedPhone)) return res.status(400).json({ error: 'Invalid US phone number' });

  // Per-phone 24h dedup
  const now = Date.now();
  const expiry = _demoPhoneExpiry.get(formattedPhone);
  if (expiry && now < expiry) {
    return res.status(429).json({ error: 'A demo call was already requested for this number — try again tomorrow.' });
  }
  _demoPhoneExpiry.set(formattedPhone, now + 24 * 60 * 60 * 1000);

  try {
    const response = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: '2b011515-2315-4cd5-8784-d8dd92bb8fc0',
        customer: { number: formattedPhone },
        phoneNumberId: '360b7e08-4cc7-462b-906a-688853bf3ddd'
      })
    });

    console.log('[demo-call] Vapi response status:', response.status);
    const rawBody = await response.text();
    console.log('[demo-call] Vapi raw response:', rawBody);

    const data = JSON.parse(rawBody);

    if (!response.ok) {
      console.error('Vapi call error:', data);
      return res.status(500).json({ error: 'Failed to initiate call', detail: data });
    }

    console.log(`Demo call triggered → ...${formattedPhone.slice(-4)}`);
    res.json({ success: true, callId: data.id });

  } catch (e) {
    console.error('Demo call error FULL:', JSON.stringify(e, Object.getOwnPropertyNames(e)));
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ERROR HANDLING ────────────────────────────────────────────────────────────

const Sentry = require('@sentry/node');
Sentry.setupExpressErrorHandler(app);

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
