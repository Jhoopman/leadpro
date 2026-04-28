// routes/billing.js
// Stripe billing: checkout sessions, webhook handler, customer portal.
// Key upgrade from original: webhook idempotency via processed_webhook_events table.
//
// Run this SQL once in Supabase before deploying:
//   CREATE TABLE IF NOT EXISTS processed_webhook_events (
//     event_id text PRIMARY KEY,
//     processed_at timestamptz DEFAULT now()
//   );

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const stripe   = require('../services/stripe');
const { catchAsync } = require('../middleware/errorHandler');
const { checkoutLimit } = require('../middleware/rateLimit');
const cfg      = require('../config');

// ── CHECKOUT ──────────────────────────────────────────────────────────────────

// POST /create-checkout-session
router.post('/create-checkout-session', checkoutLimit, catchAsync(async (req, res) => {
  if (!req.contractor) return res.status(401).json({ error: 'Please sign in first' });
  if (!cfg.stripe.secretKey) return res.status(503).json({ error: 'Billing not configured' });

  const { plan, contractorId, successUrl, cancelUrl } = req.body;
  if (!plan || !contractorId) return res.status(400).json({ error: 'Missing plan or contractorId' });

  const priceId = plan === 'pro' ? cfg.stripe.proPriceId : cfg.stripe.starterPriceId;
  if (!priceId) return res.status(503).json({ error: `Price ID not configured for plan: ${plan}` });

  const setupFeeLineItem = cfg.stripe.setupFeePriceId
    ? [{ price: cfg.stripe.setupFeePriceId, quantity: 1 }]
    : [];

  const { data: rows, error: dbErr } = await supabase
    .from('contractors')
    .select('id, business_name, stripe_customer_id')
    .eq('id', contractorId)
    .limit(1);

  if (dbErr) return res.status(500).json({ error: 'Database error: ' + dbErr.message });

  const contractor = rows?.[0];
  if (!contractor) return res.status(404).json({ error: 'Contractor not found: ' + contractorId });

  // Create Stripe customer if this is their first checkout
  let customerId = contractor.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.createCustomer({
      description: contractor.business_name,
      metadata:    { contractor_id: contractorId },
    });
    customerId = customer.id;
    await supabase.from('contractors').update({ stripe_customer_id: customerId }).eq('id', contractorId);
  }

  let session;
  try {
    session = await stripe.createCheckoutSession({
      customerId,
      priceId,
      extraLineItems: setupFeeLineItem,
      successUrl: successUrl || `${cfg.appUrl}/app?billing=success`,
      cancelUrl:  cancelUrl  || `${cfg.appUrl}/app`,
      metadata:   { contractor_id: contractorId, plan },
    });
  } catch (stripeErr) {
    console.error(
      '[checkout] Stripe error — contractor:', contractorId,
      '| plan:', plan,
      '| priceId:', priceId,
      '| key_prefix:', cfg.stripe.secretKey.slice(0, 8),
      '| error:', stripeErr.message
    );
    return res.status(502).json({
      error: `Checkout failed: ${stripeErr.message}`,
    });
  }

  res.json({ url: session.url });
}));

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

// POST /stripe-webhook
// express.raw() is applied in server.js for this route so req.rawBody is available.
router.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  // express.raw() stores the raw Buffer in req.body (not req.rawBody)
  if (!sig || !req.body) return res.status(400).json({ error: 'Missing signature or raw body' });
  if (!cfg.stripe.webhookSecret) return res.status(503).json({ error: 'Webhook secret not configured' });

  try {
    stripe.verifyWebhookSignature(req.body.toString(), sig);
  } catch (e) {
    console.warn('[stripe-webhook] Rejected:', e.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[stripe-webhook] Failed to parse event body:', e.message);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // ── IDEMPOTENCY GUARD ──
  // Stripe retries events for up to 72 hours. Storing the event ID prevents
  // double-processing (e.g., activating a plan twice from one payment).
  try {
    const { error: dupErr } = await supabase
      .from('processed_webhook_events')
      .insert({ event_id: event.id });

    if (dupErr) {
      // Unique constraint violation = already processed
      console.log('[stripe-webhook] Duplicate event, skipping:', event.id);
      return res.json({ received: true, duplicate: true });
    }
  } catch (e) {
    console.error('[stripe-webhook] Idempotency check error:', e.message);
    // Continue processing — better than silently dropping the event
  }

  // ── EVENT HANDLERS ──
  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session      = event.data.object;
        const contractorId = session.metadata?.contractor_id;
        const plan         = session.metadata?.plan || 'starter';
        if (contractorId) {
          await supabase.from('contractors').update({
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription,
            plan,
            plan_status: 'active',
          }).eq('id', contractorId);
          console.log('[stripe-webhook] Subscription activated — contractor:', contractorId, 'plan:', plan);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const { data } = await supabase
          .from('contractors')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .single();
        if (data) {
          await supabase.from('contractors').update({
            plan_status:            'inactive',
            stripe_subscription_id: null,
          }).eq('id', data.id);
          console.log('[stripe-webhook] Subscription cancelled — contractor:', data.id);
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Handle plan changes (upgrade/downgrade)
        const sub      = event.data.object;
        const priceId  = sub.items?.data?.[0]?.price?.id;
        let plan = 'starter';
        if (priceId === cfg.stripe.proPriceId) plan = 'pro';
        const { data } = await supabase
          .from('contractors')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .single();
        if (data) {
          await supabase.from('contractors').update({ plan, plan_status: sub.status }).eq('id', data.id);
          console.log('[stripe-webhook] Subscription updated — contractor:', data.id, 'plan:', plan);
        }
        break;
      }

      default:
        // Log but don't error — Stripe sends many event types
        console.log('[stripe-webhook] Unhandled event type:', event.type);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[stripe-webhook] Processing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BILLING PORTAL ────────────────────────────────────────────────────────────

// GET /billing-portal?contractorId=X
router.get('/billing-portal', catchAsync(async (req, res) => {
  if (!cfg.stripe.secretKey) return res.status(503).json({ error: 'Billing not configured' });

  const contractorId = req.query.contractorId;
  if (!contractorId) return res.status(400).json({ error: 'Missing contractorId' });

  const { data: contractor } = await supabase
    .from('contractors')
    .select('stripe_customer_id')
    .eq('id', contractorId)
    .single();

  if (!contractor?.stripe_customer_id) {
    return res.status(404).json({ error: 'No billing account found — subscribe first' });
  }

  const portal = await stripe.createPortalSession({
    customerId: contractor.stripe_customer_id,
    returnUrl:  `${cfg.appUrl}/app`,
  });

  res.json({ url: portal.url });
}));

// ── STRIPE CONFIG DIAGNOSTIC ──────────────────────────────────────────────────
// GET /api/admin/stripe-config?token=DIAGNOSTIC_TOKEN
// Returns which Stripe mode (live/test) the server key is for, and whether each
// configured price ID actually exists in that account. Hit this first whenever
// checkout fails — eliminates the "wrong mode / wrong account" guess instantly.

router.get('/api/admin/stripe-config', async (req, res) => {
  const expected = cfg.diagnosticToken;
  if (!expected) {
    return res.status(503).json({ error: 'DIAGNOSTIC_TOKEN env var not set on server' });
  }
  if (!req.query.token || req.query.token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const key  = cfg.stripe.secretKey;
  const mode = key.startsWith('sk_live_') ? 'live'
             : key.startsWith('sk_test_') ? 'test'
             : 'unknown (key missing or malformed)';

  async function validatePrice(id, label) {
    if (!id) {
      return { id: null, valid: false, error: `${label} price ID not configured (env var empty)` };
    }
    try {
      const result = await stripe.request('GET', `prices/${encodeURIComponent(id)}`, null);
      if (result.error) {
        return { id, valid: false, error: result.error.message };
      }
      return {
        id,
        valid:    true,
        amount:   result.unit_amount,           // cents — $97 = 9700
        currency: result.currency,
        nickname: result.nickname   || null,
        active:   result.active,
      };
    } catch (e) {
      return { id, valid: false, error: e.message };
    }
  }

  const [starter, pro] = await Promise.all([
    validatePrice(cfg.stripe.starterPriceId, 'STRIPE_STARTER_PRICE_ID'),
    validatePrice(cfg.stripe.proPriceId,     'STRIPE_PRO_PRICE_ID'),
  ]);

  const allOk = starter.valid && pro.valid;
  console.log('[stripe-config-diag] mode:', mode, '| starter valid:', starter.valid, '| pro valid:', pro.valid);

  res.status(allOk ? 200 : 500).json({ mode, starter, pro });
});

module.exports = router;
