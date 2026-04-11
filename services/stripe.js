// services/stripe.js
// Raw HTTPS wrapper for Stripe API calls (no SDK dependency).
// Keeps all Stripe logic in one place for easy SDK migration later.

const https  = require('https');
const crypto = require('crypto');
const cfg    = require('../config');

// ── FLAT PARAM ENCODING ─────────────────────────────────────────────────────
// Stripe uses form-encoded nested params: line_items[0][price]=abc

function flattenParams(obj, prefix) {
  const out = {};
  (function walk(o, p) {
    Object.keys(o).forEach(k => {
      const key = p ? `${p}[${k}]` : k;
      if (Array.isArray(o[k])) {
        o[k].forEach((item, i) => {
          if (item !== null && typeof item === 'object') walk(item, `${key}[${i}]`);
          else out[`${key}[${i}]`] = String(item);
        });
      } else if (o[k] !== null && typeof o[k] === 'object') {
        walk(o[k], key);
      } else if (o[k] !== undefined) {
        out[key] = String(o[k]);
      }
    });
  })(obj, prefix || '');
  return out;
}

// ── REQUEST ─────────────────────────────────────────────────────────────────

function request(method, path, params) {
  return new Promise((resolve, reject) => {
    const flat = params ? flattenParams(params) : {};
    const body = new URLSearchParams(flat).toString();

    const req = https.request({
      hostname: 'api.stripe.com',
      port:     443,
      path:     '/v1/' + path,
      method,
      headers:  {
        'Authorization':  'Bearer ' + cfg.stripe.secretKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Stripe parse error: ' + e.message)); }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── WEBHOOK SIGNATURE ───────────────────────────────────────────────────────

function verifyWebhookSignature(rawBody, sigHeader) {
  const parts  = sigHeader.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) throw new Error('Invalid Stripe-Signature header');

  const ts       = tsPart.slice(2);
  const sig      = sigPart.slice(3);
  const expected = crypto
    .createHmac('sha256', cfg.stripe.webhookSecret)
    .update(ts + '.' + rawBody)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('Stripe signature mismatch');
  }
}

// ── CONVENIENCE METHODS ─────────────────────────────────────────────────────

async function createCustomer({ description, metadata }) {
  const customer = await request('POST', 'customers', { description, metadata });
  if (customer.error) throw new Error(customer.error.message);
  return customer;
}

async function createCheckoutSession({ customerId, priceId, successUrl, cancelUrl, metadata }) {
  const session = await request('POST', 'checkout/sessions', {
    customer:   customerId,
    mode:       'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url:  cancelUrl,
    metadata,
  });
  if (session.error) throw new Error(session.error.message);
  return session;
}

async function createPortalSession({ customerId, returnUrl }) {
  const portal = await request('POST', 'billing_portal/sessions', {
    customer:   customerId,
    return_url: returnUrl,
  });
  if (portal.error) throw new Error(portal.error.message);
  return portal;
}

module.exports = {
  request,
  verifyWebhookSignature,
  createCustomer,
  createCheckoutSession,
  createPortalSession,
};
