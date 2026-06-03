// routes/sms-consent.js
// POST /api/sms-consent — public, no auth required.
// Records homeowner SMS opt-in for A2P/TCR compliance.

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { catchAsync } = require('../middleware/errorHandler');

const CONSENT_TEXT = 'I agree to receive text messages from LeadPro about my request, appointment scheduling, and related follow-ups. Message frequency varies. Message and data rates may apply. Reply HELP for help, STOP to cancel.';

function toE164(raw) {
  const digits = raw.replace(/\D/g, '');
  if (/^\+[1-9]\d{1,14}$/.test(raw)) return raw;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

router.post('/api/sms-consent', catchAsync(async (req, res) => {
  const body = req.body || {};
  const { name = '', phone, consent } = body;

  if (consent !== true) {
    return res.status(400).json({ success: false, error: 'consent required' });
  }

  const e164 = phone ? toE164(String(phone).trim()) : null;
  if (!e164) {
    return res.status(400).json({ success: false, error: 'invalid phone number' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const user_agent = req.headers['user-agent'] || '';

  const { error } = await supabase.from('sms_consents').insert({
    phone:        e164,
    name:         String(name).trim(),
    consent_text: CONSENT_TEXT,
    ip,
    user_agent,
    source:       'text-page',
  });

  if (error) {
    console.error('[sms-consent] insert error:', error.message);
    return res.status(500).json({ success: false, error: 'database error' });
  }

  console.log(`[sms-consent] recorded — phone=${e164} ip=${ip}`);
  res.json({ success: true });
}));

module.exports = router;
