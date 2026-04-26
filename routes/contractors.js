// routes/contractors.js
// Contractor profile lookup (used by widget) and account provisioning.

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const email    = require('../services/email');
const cfg      = require('../config');
const { catchAsync } = require('../middleware/errorHandler');
const { contractorLookupLimit } = require('../middleware/rateLimit');

// Thin Twilio SMS helper (avoids importing the full twilio route)
function sendSms(to, body) {
  if (!cfg.twilio.accountSid || !cfg.twilio.authToken || !to) return Promise.resolve();
  const https   = require('https');
  const payload = new URLSearchParams({ To: to, From: cfg.twilio.phone, Body: body }).toString();
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${cfg.twilio.accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${cfg.twilio.accountSid}:${cfg.twilio.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(payload);
    req.end();
  });
}

// GET /contractor/:id — widget fetches contractor profile by widget_id
router.get('/contractor/:id', contractorLookupLimit, catchAsync(async (req, res) => {
  const { data, error } = await supabase
    .from('contractors')
    .select('id, business_name, services, google_connected')
    .eq('widget_id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contractor not found' });
  res.json(data);
}));

// POST /ensure-contractor — creates contractor row via service key if it doesn't exist.
// Called from frontend after signup (RLS blocks anon insert while email confirmation is pending).
router.post('/ensure-contractor', catchAsync(async (req, res) => {
  const { userId, businessName } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const { data: existing } = await supabase
    .from('contractors')
    .select('id')
    .eq('id', userId)
    .limit(1);

  if (existing?.[0]) return res.json({ created: false });

  const widgetId  = 'lp_' + Math.random().toString(36).substr(2, 8);
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 14);

  const { error } = await supabase.from('contractors').insert({
    id:           userId,
    business_name: businessName || '',
    widget_id:    widgetId,
    plan:         'free',
    plan_status:  'trial',
    trial_ends_at: trialEnds.toISOString(),
  });

  if (error) throw new Error(error.message);
  res.json({ created: true, widgetId });
}));

// POST /api/onboarding/complete
router.post('/api/onboarding/complete', catchAsync(async (req, res) => {
  const { contractor_id } = req.body;
  if (!contractor_id) return res.status(400).json({ error: 'contractor_id required' });

  const { data: contractor, error: dbErr } = await supabase
    .from('contractors')
    .select('id, business_name, owner_email')
    .eq('id', contractor_id)
    .single();

  if (dbErr || !contractor) return res.status(404).json({ error: 'Contractor not found' });

  await supabase
    .from('contractors')
    .update({ status: 'active', onboarding_done: true })
    .eq('id', contractor_id);

  // Email contractor: "Your LeadPro AI is live!"
  if (contractor.owner_email && cfg.resendApiKey) {
    email.send(
      contractor.owner_email,
      'Your LeadPro AI is live! 🎉',
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h1 style="color:#2d7a4e">You're live on LeadPro! 🎉</h1>
        <p>Your AI receptionist at <strong>+1 (302) 664-7594</strong> is now answering calls 24/7.</p>
        <p>Every call is captured, qualified, and sent to your dashboard automatically.</p>
        <p><a href="${cfg.appUrl}/app" style="color:#2d7a4e">Go to your dashboard →</a></p>
      </div>`
    ).catch(e => console.error('[onboarding/complete] email error:', e.message));
  }

  // SMS alert to ALERT_PHONE
  if (cfg.alertPhone) {
    sendSms(
      cfg.alertPhone,
      `🎉 New customer live: ${contractor.business_name || contractor_id}`
    ).catch(e => console.error('[onboarding/complete] SMS error:', e.message));
  }

  res.json({ success: true });
}));

module.exports = router;
