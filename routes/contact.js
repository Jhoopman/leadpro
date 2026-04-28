// routes/contact.js
// POST /contact — marketing homepage contact form.
// Public endpoint, no auth required.

const express = require('express');
const router  = express.Router();
const email   = require('../services/email');
const cfg     = require('../config');
const { createLimiter } = require('../middleware/rateLimit');

const contactLimit = createLimiter({
  maxRequests: 5,
  windowMs:    60 * 60 * 1000,
  message:     'Too many messages — try again in an hour.',
});

function countUrls(text) {
  return (text.match(/https?:\/\/\S+/gi) || []).length;
}

router.post('/contact', contactLimit, async (req, res) => {
  const { name, business, phone, email: userEmail, message } = req.body || {};

  if (!name || !userEmail || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  if (countUrls(message) > 3) {
    return res.status(400).json({ error: 'Message flagged as spam.' });
  }

  const html = `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <h1 style="color:#e8f5ec;font-size:18px;margin:0">New Contact Form Inquiry</h1>
    <p style="color:#7db896;font-size:13px;margin:6px 0 0">useleadpro.net</p>
  </div>
  <div style="background:#f5f5f3;border-radius:8px;padding:16px">
    <table style="width:100%;font-size:13px;color:#2c2c2a">
      <tr><td style="color:#888;padding:5px 0;width:100px">Name</td>
          <td style="font-weight:500">${name}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Business</td>
          <td style="font-weight:500">${business || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Phone</td>
          <td style="font-weight:500">${phone || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Email</td>
          <td style="font-weight:500">${userEmail}</td></tr>
      <tr><td style="color:#888;padding:5px 0;vertical-align:top">Message</td>
          <td style="font-weight:500;white-space:pre-wrap">${message}</td></tr>
    </table>
  </div>
</div>`;

  try {
    await email.send(cfg.alertEmail, `Contact form: ${name} — ${business || userEmail}`, html);
    res.json({ ok: true });
  } catch (err) {
    console.error('[contact] email send failed:', err.message);
    res.status(500).json({ error: 'Failed to send — please email hello@useleadpro.net directly.' });
  }
});

module.exports = router;
