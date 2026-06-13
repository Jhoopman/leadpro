// server.js — LeadPro entry point
// This file only wires things together. No business logic lives here.
// Target: stay under 100 lines. If it grows, something is in the wrong place.

require('./instrument.js');
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');

const cfg    = require('./config');
const crypto = require('crypto');

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

app.use('/assets', express.static(path.join(__dirname, 'assets')));

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

// ── ADMIN HUB ─────────────────────────────────────────────────────────────────
// Private route — never document publicly. Returns 404 (not 401) to obscure existence.

function signHubToken(ts) {
  return crypto.createHmac('sha256', process.env.HUB_PASSWORD || 'hub-no-pass').update(ts).digest('hex');
}

function verifyHubCookie(cookieHeader) {
  if (!cookieHeader) return false;
  const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('hub_session='));
  if (!match) return false;
  try {
    const val = decodeURIComponent(match.slice('hub_session='.length));
    const [ts, sig] = val.split('.');
    if (!ts || !sig) return false;
    if (Date.now() - parseInt(ts, 10) > 30 * 24 * 60 * 60 * 1000) return false;
    const expected = signHubToken(ts);
    const sigBuf = Buffer.from(sig,      'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch { return false; }
}

function setHubCookie(res) {
  const ts    = Date.now().toString();
  const token = `${ts}.${signHubToken(ts)}`;
  res.setHeader('Set-Cookie',
    `hub_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}; Path=/admin`
  );
}

// POST /admin/hub-auth — validate HUB_PASSWORD env var, issue hub_session cookie
app.post('/admin/hub-auth', (req, res) => {
  const { password } = req.body || {};
  const expected = cfg.hubPassword;
  if (!expected || !password || password !== expected) {
    return res.status(401).json({ ok: false });
  }
  setHubCookie(res);
  res.json({ ok: true });
});

// GET /admin/hub — serve Marketing Hub HTML (404 to unauthenticated)
// Layer 1: X-Internal-Key header (curl/programmatic)
// Layer 1b: ?key= query param (Chrome shortcut bootstrap → sets cookie, redirects clean)
// Layer 2: valid hub_session cookie (browser sessions after bootstrap)
app.get('/admin/hub', (req, res) => {
  const validKey = process.env.INTERNAL_API_KEY;

  // INTERNAL KEY BYPASS — header (programmatic access)
  if (req.headers['x-internal-key'] === validKey) {
    return res.sendFile(path.join(__dirname, 'LeadPro-Marketing-Hub.html'));
  }

  // INTERNAL KEY BYPASS — query param bootstrap: set cookie → redirect to clean URL
  if (req.query.key && req.query.key === validKey) {
    setHubCookie(res);
    return res.redirect(302, '/admin/hub');
  }

  // Cookie layer — valid signed hub_session
  if (verifyHubCookie(req.headers.cookie)) {
    return res.sendFile(path.join(__dirname, 'LeadPro-Marketing-Hub.html'));
  }

  res.status(404).end();
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
app.get('/',       (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
// Sub-brand pages
app.get('/design',     (_, res) => res.sendFile(path.join(__dirname, 'design.html')));
app.get('/agents',     (_, res) => res.sendFile(path.join(__dirname, 'agents.html')));
app.get('/marketing',  (_, res) => res.sendFile(path.join(__dirname, 'marketing.html')));
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
// INTERNAL KEY BYPASS — desktop Marketing Hub only.
// Replaces the separate requireAuth + requirePlan('pro') for /api/prospector.
// All other routes are unaffected.
app.use('/api/prospector', (req, res, next) => {
  const internalKey = req.headers['x-internal-key'];
  if (internalKey && internalKey === process.env.INTERNAL_API_KEY) {
    return next(); // INTERNAL KEY BYPASS — authenticated, skip plan gate
  }
  // Normal path: verify Bearer token then enforce Pro plan
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requirePlan('pro')(req, res, next);
  });
});

// INTERNAL KEY BYPASS — Marketing Hub script generator.
// Calls Anthropic on behalf of the desktop Hub; key never leaves the server.
app.post('/api/generate-script', (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!cfg.anthropicApiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { business_name = '', owner_name = '', trade = '', city = '', score = 0, website = '' } = req.body || {};

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: 'You are a cold call script writer for LeadPro, an AI receptionist tool for contractors. Write punchy, conversational scripts — not robotic. The caller is Josiah from LeadPro. Format with clear labeled sections: OPENER, PAIN POINT, PITCH, OBJECTIONS, CLOSE. Keep the whole script under 90 seconds spoken.',
    messages: [{
      role: 'user',
      content: `Write a cold call script for this lead:\nBusiness: ${business_name}\nOwner: ${owner_name || 'the owner'}\nTrade: ${trade}\nCity: ${city}\nScore: ${score}/100\nWebsite: ${website || 'no website listed'}\n\nPersonalize for their specific trade and city. Make the pain point real for a ${trade} contractor.`,
    }],
  });

  const https = require('https');
  const apiReq = https.request({
    hostname: 'api.anthropic.com',
    path:     '/v1/messages',
    method:   'POST',
    headers: {
      'Content-Type':      'application/json',
      'Content-Length':    Buffer.byteLength(payload),
      'x-api-key':         cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
  }, apiRes => {
    let d = '';
    apiRes.on('data', c => d += c);
    apiRes.on('end', () => {
      try {
        const body = JSON.parse(d);
        if (apiRes.statusCode !== 200) {
          console.error('[generate-script] Anthropic error', apiRes.statusCode, d.slice(0, 200));
          return res.status(502).json({ error: body.error?.message || 'Anthropic error' });
        }
        res.json({ script: body.content?.[0]?.text || '' });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse Anthropic response' });
      }
    });
  });
  apiReq.on('error', e => {
    console.error('[generate-script] request error:', e.message);
    res.status(500).json({ error: e.message });
  });
  apiReq.write(payload);
  apiReq.end();
});

// INTERNAL KEY BYPASS — generate social/email content via Anthropic
app.post('/api/generate-content', (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!cfg.anthropicApiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }
  const { platform = 'LinkedIn', topic = 'AI receptionist for contractors' } = req.body || {};
  const formatGuide = {
    LinkedIn:  'Professional tone, 150–250 words, 2–3 short paragraphs, ends with a soft question or CTA to useleadpro.net',
    Instagram: 'Punchy hook first line, conversational, 80–120 words, 3–5 relevant hashtags at the end',
    Facebook:  'Friendly and direct, 100–180 words, story-driven if possible, ends with CTA to useleadpro.net',
    Email:     'Subject line on first line (prefix "Subject: "), then blank line, then 120–200 word body, professional but warm',
  };
  const guide = formatGuide[platform] || formatGuide.LinkedIn;
  const systemPrompt = `You write social media and email content for LeadPro, an AI receptionist SaaS built for home-service contractors (roofing, HVAC, plumbing, landscaping, etc.). LeadPro answers missed calls 24/7, texts callers back instantly, and helps contractors never lose a lead again. Pain-point driven, conversational, no corporate jargon. Website: useleadpro.net.`;
  const userPrompt = `Write a ${platform} post about: "${topic}". Format guide: ${guide}. Output the post text only — no commentary, no labels, no markdown formatting.`;

  const https = require('https');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
  };
  const apiReq = https.request(options, apiRes => {
    let d = '';
    apiRes.on('data', c => d += c);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(d);
        if (apiRes.statusCode !== 200) { console.error('[generate-content] Anthropic error', apiRes.statusCode, d.slice(0,200)); return res.status(502).json({ error: parsed.error?.message || 'Anthropic error' }); }
        const content = parsed.content?.[0]?.text || '';
        res.json({ content });
      } catch(e) { res.status(500).json({ error: 'Parse error' }); }
    });
  });
  apiReq.on('error', e => { console.error('[generate-content] error:', e.message); res.status(500).json({ error: e.message }); });
  apiReq.write(body);
  apiReq.end();
});

// INTERNAL KEY BYPASS — re-score a single known lead by website URL
app.post('/api/rescore-lead', async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { website = '', phone = '' } = req.body || {};
  const scraper = require('./services/scraper');
  const analysis = {
    hasWebsite: !!website, hasChatWidget: false, hasPhone: !!phone,
    websiteQualityScore: 0, hasSSL: false, hasMobileViewport: false, rating: null,
  };
  if (website) {
    try {
      const siteUrl = website.startsWith('http') ? website : 'https://' + website;
      const { html, finalUrl } = await scraper.fetchPageHTML(siteUrl);
      analysis.hasChatWidget = scraper.checkChatWidget(html);
      if (!analysis.hasPhone) analysis.hasPhone = scraper.checkPhoneNumber(html);
      const q = scraper.checkWebsiteQuality(html, finalUrl);
      analysis.hasSSL = q.hasSSL;
      analysis.hasMobileViewport = q.hasMobileViewport;
      analysis.websiteQualityScore = q.score;
    } catch (e) {
      console.log('[rescore-lead] fetch error:', website, e.message);
    }
  }
  const { score, missing } = scraper.scoreContractor(analysis);
  res.json({ score, missing, factors: analysis });
});

// INTERNAL KEY BYPASS — send an email sequence step via Resend
app.post('/api/send-sequence', async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { to = '', subject = '', body = '', lead_name = '' } = req.body || {};
  if (!to || !to.includes('@')) {
    console.log('[send-sequence] no valid email for lead:', lead_name || '(unknown)');
    return res.json({ sent: false, reason: 'no_email' });
  }
  if (!cfg.resendApiKey) {
    return res.status(503).json({ sent: false, error: 'RESEND_API_KEY not configured' });
  }
  try {
    const emailSvc = require('./services/email');
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
      ${body.split('\n').filter(l=>l.trim()).map(l=>`<p style="margin:0 0 14px;line-height:1.65;font-size:15px">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>`).join('')}
      <hr style="border:none;border-top:1px solid #e8e8e6;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">Sent via LeadPro &nbsp;&middot;&nbsp; <a href="https://useleadpro.net" style="color:#2d7a4e;text-decoration:none">useleadpro.net</a></p>
    </div>`;
    await emailSvc.send(to, subject, html);
    res.json({ sent: true });
  } catch (e) {
    console.error('[send-sequence] Resend error:', e.message);
    res.status(500).json({ sent: false, error: e.message });
  }
});

// INTERNAL KEY BYPASS — send weekly summary email via Resend
app.post('/api/send-weekly-summary', async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { to = '', summary = {} } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to required' });
  if (!cfg.resendApiKey) {
    return res.status(503).json({ sent: false, error: 'RESEND_API_KEY not configured' });
  }
  const { newLeads=0, movedLeads=0, closedLeads=0, posted=0, staleLeads=0, topLead=null } = summary;
  const date = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;background:#0A0A0A;color:#f0f0f5">
  <div style="background:linear-gradient(135deg,#0d2818,#0A0A0A);border-bottom:1px solid rgba(45,122,78,0.25);padding:28px 32px">
    <p style="font-size:11px;font-weight:700;color:#2d7a4e;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 6px">LeadPro · Weekly Report</p>
    <h1 style="font-size:22px;font-weight:700;color:#f0f0f5;margin:0">${date}</h1>
  </div>
  <div style="padding:28px 32px">
    <table style="width:100%;border-collapse:separate;border-spacing:8px">
      <tr>
        <td style="background:#161616;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px;width:50%">
          <div style="font-size:11px;color:#555;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.07em">New Leads</div>
          <div style="font-size:26px;font-weight:800;color:#52D99A">${newLeads}</div>
        </td>
        <td style="background:#161616;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px;width:50%">
          <div style="font-size:11px;color:#555;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.07em">Leads Moved</div>
          <div style="font-size:26px;font-weight:800;color:#3B82F6">${movedLeads}</div>
        </td>
      </tr>
      <tr>
        <td style="background:#161616;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px">
          <div style="font-size:11px;color:#555;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.07em">Deals Closed</div>
          <div style="font-size:26px;font-weight:800;color:#FF3B3B">${closedLeads}</div>
        </td>
        <td style="background:#161616;border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px">
          <div style="font-size:11px;color:#555;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.07em">Content Posted</div>
          <div style="font-size:26px;font-weight:800;color:#F59E0B">${posted}</div>
        </td>
      </tr>
    </table>
    ${topLead ? `<div style="background:#161616;border:1px solid rgba(82,217,154,0.18);border-radius:10px;padding:16px;margin-top:16px"><div style="font-size:11px;color:#2d7a4e;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px">Top Lead</div><div style="font-size:16px;font-weight:700;color:#f0f0f5">${topLead.name||'—'}</div><div style="font-size:13px;color:#666;margin-top:2px">${topLead.trade||''} · ${topLead.city||''} · Score ${topLead.score||0}</div></div>` : ''}
    ${staleLeads > 0 ? `<div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.18);border-radius:8px;padding:12px 16px;margin-top:16px;font-size:13.5px;color:#F59E0B">⚠️ ${staleLeads} lead${staleLeads>1?'s':''} need follow-up — no movement in 3+ days.</div>` : ''}
  </div>
  <div style="padding:16px 32px 24px;border-top:1px solid rgba(255,255,255,0.05)">
    <p style="font-size:12px;color:#444;margin:0;text-align:center"><a href="https://app.useleadpro.net" style="color:#2d7a4e;text-decoration:none">Open Dashboard</a> &nbsp;·&nbsp; LeadPro</p>
  </div>
</div>`;
  try {
    const emailSvc = require('./services/email');
    await emailSvc.send(to, `LeadPro Weekly — ${date}`, html);
    res.json({ sent: true });
  } catch (e) {
    console.error('[send-weekly-summary] error:', e.message);
    res.status(500).json({ sent: false, error: e.message });
  }
});

// Plan gates — always after requireAuth (reads req.contractor, no extra DB calls)
app.post('/api',              requirePlan('starter'));   // /api chat proxy → Starter+
app.use('/send-confirmation', requirePlan('starter'));
app.use('/calendar',          requirePlan('starter'));
app.use('/billing-portal',    requirePlan('starter'));

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
    console.log('[demo-call] VAPI_API_KEY present:', !!process.env.VAPI_API_KEY);
    console.log('[demo-call] Attempting fetch to Vapi...');

    let response;
    try {
      response = await fetch('https://api.vapi.ai/call/phone', {
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
      console.log('[demo-call] fetch completed, status:', response.status);
    } catch (fetchErr) {
      console.error('[demo-call] fetch THREW:', fetchErr.message, fetchErr.stack);
      return res.status(500).json({ error: 'Fetch failed', detail: fetchErr.message });
    }

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

// ── SUB-BRAND LEAD CAPTURE ────────────────────────────────────────────────────

const _email = require('./services/email');

app.post('/api/design-lead', async (req, res) => {
  const { name, biz, phone, email: userEmail, budget } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  try {
    await _email.send(
      cfg.alertEmail,
      `New DESIGN inquiry: ${name} — ${biz || 'unknown biz'}`,
      `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#C9A96E">LeadPro Design Lead</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Business:</strong> ${biz || '—'}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Email:</strong> ${userEmail || '—'}</p>
        <p><strong>Package:</strong> ${budget || '—'}</p>
      </div>`
    );
    console.log(`[design-lead] ${name} — ${phone}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[design-lead]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/marketing-lead', async (req, res) => {
  const { name, biz, phone, email: userEmail, services, pkg } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  try {
    await _email.send(
      cfg.alertEmail,
      `New MARKETING inquiry: ${name} — ${biz || 'unknown biz'}`,
      `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#FF6B4A">LeadPro Marketing Lead</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Business:</strong> ${biz || '—'}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Email:</strong> ${userEmail || '—'}</p>
        <p><strong>Services interested in:</strong> ${services || '—'}</p>
        <p><strong>Package:</strong> ${pkg || '—'}</p>
      </div>`
    );
    console.log(`[marketing-lead] ${name} — ${phone}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[marketing-lead]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agent-lead', async (req, res) => {
  const { name, biz, phone, email: userEmail, desc } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  try {
    await _email.send(
      cfg.alertEmail,
      `New AGENTS inquiry: ${name} — ${biz || 'unknown biz'}`,
      `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#818CF8">LeadPro Agents Lead</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Business:</strong> ${biz || '—'}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Email:</strong> ${userEmail || '—'}</p>
        <p><strong>Description:</strong> ${desc || '—'}</p>
        <p><strong>Package:</strong> ${req.body.package || '—'}</p>
      </div>`
    );
    console.log(`[agent-lead] ${name} — ${phone}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[agent-lead]', e.message);
    res.status(500).json({ error: e.message });
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
