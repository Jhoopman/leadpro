// routes/consent.js
// POST /api/log-consent — records IP + User-Agent after a contractor completes
// the SMS consent checkbox at signup. mobile_phone and sms_consent_given are
// written by routes/auth.js during the signup insert; this endpoint fills in
// the forensic fields that are only available client-side.

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { catchAsync } = require('../middleware/errorHandler');

router.post('/api/log-consent', catchAsync(async (req, res) => {
  const { contractor_id, user_agent } = req.body;
  if (!contractor_id) return res.status(400).json({ error: 'contractor_id required' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

  await supabase.from('contractors')
    .update({ sms_consent_ip: ip, sms_consent_user_agent: user_agent || null })
    .eq('id', contractor_id);

  console.log(`[Consent] logged for ${contractor_id} — ip=${ip}`);
  res.json({ success: true });
}));

module.exports = router;
