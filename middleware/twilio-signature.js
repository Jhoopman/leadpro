// middleware/twilio-signature.js
// Verifies Twilio's X-Twilio-Signature header on every inbound Twilio webhook.
//
// Twilio's algorithm (equivalent to twilio.validateRequest from the twilio npm package):
//   1. Full request URL (https://host/path?query)
//   2. POST params sorted alphabetically by key, concatenated as key+value
//   3. HMAC-SHA1 of (url + params) with TWILIO_AUTH_TOKEN
//   4. Base64 result must match X-Twilio-Signature (timing-safe compare)
//
// Applied to: POST /twilio/voice, /twilio/voice/status, /twilio/sms, /twilio/sms/status
// NOT applied to: /vapi-webhook (different scheme), /stripe-webhook (different scheme)
// Enforcement: production only — dev/test skips so local curl/ngrok testing works.

const crypto = require('crypto');
const cfg    = require('../config');

function verifyTwilioSignature(req, res, next) {
  // Skip in dev/test so local webhook testing works without a valid signature
  if (process.env.NODE_ENV !== 'production') return next();

  const authToken = cfg.twilio?.authToken;
  if (!authToken) {
    console.error('[Twilio] BLOCKED — TWILIO_AUTH_TOKEN missing in production');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const sig = req.headers['x-twilio-signature'];
  const ts  = new Date().toISOString();

  if (!sig) {
    console.warn(`[Twilio] REJECTED missing-signature path=${req.path} ts=${ts}`);
    return res.status(403).send('Forbidden');
  }

  // Reconstruct the full URL Twilio used to sign the request.
  // Render terminates TLS at the edge; x-forwarded-host carries the public hostname.
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url  = `https://${host}${req.originalUrl}`;

  const params = req.body || {};
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn(`[Twilio] REJECTED bad-signature path=${req.path} ts=${ts}`);
    return res.status(403).send('Forbidden');
  }

  next();
}

module.exports = { verifyTwilioSignature };
