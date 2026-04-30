// routes/auth.js
// Signup, login, logout, and token-verification routes.
// Also exports requireAuth middleware — import it in any route file that needs auth:
//   const { requireAuth } = require('./auth');

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { catchAsync } = require('../middleware/errorHandler');
const { authLimit }  = require('../middleware/rateLimit');

// ── HELPERS ───────────────────────────────────────────────────────────────────

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ── SIGNUP ────────────────────────────────────────────────────────────────────
// POST /auth/signup
// Creates Supabase Auth user + contractors row, returns session tokens.

router.post('/auth/signup', authLimit, catchAsync(async (req, res) => {
  const { email, password, business_name, mobile_phone, sms_consent_given } = req.body;

  // ── Validation ──
  if (!email || !password || !business_name) {
    return res.status(400).json({ error: 'email, password, and business_name are required' });
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const cleanEmail = email.toLowerCase().trim();

  // ── Step 1: Create auth user ──
  console.log('[auth/signup] step 1 — createUser', { email: cleanEmail });
  const { data: authData, error: createErr } = await supabase.auth.admin.createUser({
    email:         cleanEmail,
    password,
    email_confirm: true,
  });

  if (createErr) {
    console.error('[auth/signup] step 1 FAILED — createUser:', createErr.message, { status: createErr.status });
    const msg = createErr.message || '';
    if (msg.includes('already registered') || msg.includes('already exists') || msg.includes('duplicate')) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    return res.status(400).json({ error: msg || 'Could not create account' });
  }

  const user = authData?.user;
  if (!user?.id) {
    console.error('[auth/signup] step 1 FAILED — createUser returned no user:', JSON.stringify(authData));
    return res.status(500).json({ error: 'Could not create account — please try again' });
  }
  console.log('[auth/signup] step 1 OK — user created', { userId: user.id });

  // ── Step 2: Create contractors row ──
  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const widgetId    = 'lp_' + Math.random().toString(36).substr(2, 8);
  const consentAt = sms_consent_given ? new Date().toISOString() : null;
  const contractorPayload = {
    id:                 user.id,
    email:              cleanEmail,
    business_name:      business_name.trim(),
    plan:               'free',
    plan_status:        'trial',
    trial_ends_at:      trialEndsAt,
    widget_id:          widgetId,
    mobile_phone:       mobile_phone?.trim() || '',
    sms_consent_given:  sms_consent_given === true,
    sms_consent_at:     consentAt,
  };
  console.log('[auth/signup] step 2 — inserting contractor row', contractorPayload);

  const { error: insertErr } = await supabase.from('contractors').insert(contractorPayload);

  if (insertErr) {
    // Soft-fail: user gets their auth account; contractor row can be fixed manually.
    console.error('[signup] contractor provision failed:', insertErr.message,
      { code: insertErr.code, hint: insertErr.hint });
  } else {
    console.log('[auth/signup] step 2 OK — contractor row inserted');
  }

  // ── Step 3: Issue session ──
  console.log('[auth/signup] step 3 — signInWithPassword');
  const { data: { session }, error: sessionErr } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (sessionErr || !session) {
    console.error('[auth/signup] step 3 FAILED — signInWithPassword:', sessionErr?.message);
    return res.status(500).json({ error: 'Account created — please sign in to continue' });
  }
  console.log('[auth/signup] step 3 OK — session issued');

  const { data: contractor } = await supabase
    .from('contractors')
    .select('id, business_name, plan, plan_status, trial_ends_at, widget_id')
    .eq('id', user.id)
    .single();

  res.status(201).json({
    access_token:  session.access_token,
    refresh_token: session.refresh_token,
    expires_at:    session.expires_at,
    contractor,
    widget_id:     contractor?.widget_id || widgetId,
  });
}));

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// POST /auth/login

router.post('/auth/login', authLimit, catchAsync(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data: { session }, error } = await supabase.auth.signInWithPassword({
    email:    email.toLowerCase().trim(),
    password,
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('Invalid login') || msg.includes('invalid credentials') || msg.includes('Invalid email or password')) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    if (msg.includes('Email not confirmed')) {
      return res.status(401).json({ error: 'Please confirm your email address first' });
    }
    if (msg.includes('Too many') || msg.includes('rate limit')) {
      return res.status(429).json({ error: 'Too many attempts — please wait a moment' });
    }
    return res.status(401).json({ error: msg || 'Sign in failed' });
  }

  const { data: contractor } = await supabase
    .from('contractors')
    .select('id, business_name, plan, plan_status, trial_ends_at')
    .eq('id', session.user.id)
    .single();

  res.json({
    access_token:  session.access_token,
    refresh_token: session.refresh_token,
    expires_at:    session.expires_at,
    contractor,
  });
}));

// ── LOGOUT ────────────────────────────────────────────────────────────────────
// POST /auth/logout
// Best-effort server-side invalidation. Client must also remove localStorage tokens.

router.post('/auth/logout', catchAsync(async (req, res) => {
  const token = tokenFrom(req);
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token).catch(() => ({ data: { user: null } }));
    if (user) {
      try { await supabase.auth.admin.signOut(user.id); } catch (_) { /* non-fatal */ }
    }
  }
  res.json({ ok: true });
}));

// ── ME ────────────────────────────────────────────────────────────────────────
// GET /auth/me — Verify token, return user + contractor profile

router.get('/auth/me', catchAsync(async (req, res) => {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { data: contractor } = await supabase
    .from('contractors')
    .select('id, email, business_name, plan, plan_status, trial_ends_at')
    .eq('id', user.id)
    .single();

  res.json({ user, contractor });
}));

// ── MY CONTRACTOR ─────────────────────────────────────────────────────────────
// GET /my-contractor — fetch the authenticated user's contractor row.
// Lightweight alternative to /auth/me when only the contractor record is needed.

router.get('/my-contractor', catchAsync(async (req, res) => {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { data, error } = await supabase
    .from('contractors')
    .select('widget_id, business_name, plan, plan_status')
    .eq('id', user.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contractor not found' });
  res.json(data);
}));

// ── REQUIRE AUTH MIDDLEWARE ───────────────────────────────────────────────────
// Reads Authorization: Bearer <token>, verifies with Supabase,
// and attaches req.user + req.contractor for downstream route handlers.

async function requireAuth(req, res, next) {
  const token = tokenFrom(req);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required — please sign in' });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }

  const { data: contractor, error: cErr } = await supabase
    .from('contractors')
    .select('*')
    .eq('id', user.id)
    .single();

  if (cErr || !contractor) {
    return res.status(401).json({ error: 'Contractor account not found' });
  }

  req.user       = user;
  req.contractor = contractor;
  next();
}

module.exports            = router;
module.exports.requireAuth = requireAuth;
