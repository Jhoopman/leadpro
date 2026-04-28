// routes/demo.js
// POST /demo-call — hero section demo-call flow.

const express = require('express');
const router  = express.Router();
const { createLimiter } = require('../middleware/rateLimit');

const demoIpLimit = createLimiter({
  maxRequests: 3,
  windowMs:    60 * 60 * 1000,
  message:     'Too many demo requests — try again in an hour.',
});

// Per-phone 24h dedup — in-memory is fine for a single Render instance.
// Swap for Redis if you ever run multiple dynos.
const phoneExpiry = new Map(); // phone → expiresAt

const E164 = /^\+1[2-9]\d{9}$/;

router.post('/demo-call', demoIpLimit, (req, res) => {
  const { phone } = req.body || {};

  if (!phone || !E164.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid US phone number (e.g. +15405550123).' });
  }

  const now    = Date.now();
  const expiry = phoneExpiry.get(phone);
  if (expiry && now < expiry) {
    return res.status(429).json({ error: 'A demo call was already requested for this number — try again tomorrow.' });
  }
  phoneExpiry.set(phone, now + 24 * 60 * 60 * 1000);

  console.log(`[${new Date().toISOString()}] [demo-call] phone: ...${phone.slice(-4)}, ip: ${req.ip}`);
  // TODO: trigger Vapi call → await vapiClient.calls.create({ phone })

  res.json({ ok: true, eta_seconds: 30 });
});

module.exports = router;
