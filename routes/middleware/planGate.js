// routes/middleware/planGate.js
// Plan-based access control. Always runs AFTER requireAuth.
// Reads req.contractor set by requireAuth — no extra DB calls.
//
// Usage:
//   const { requirePlan } = require('./middleware/planGate');
//   app.post('/api/some-route', requireAuth, requirePlan('starter'));
//   app.use('/api/pro-route',   requireAuth, requirePlan('pro'));
//
// Plan hierarchy: starter (1) < pro (2)
//
// Access matrix:
//   plan_status = 'trial'  + trial_ends_at > now  → allow everything
//   plan_status = 'active' + plan = 'starter'      → allow minPlan = 'starter'
//   plan_status = 'active' + plan = 'pro'           → allow everything
//   anything else                                   → 403

const PLAN_RANK = { starter: 1, pro: 2 };

function requirePlan(minPlan) {
  if (!PLAN_RANK[minPlan]) {
    throw new Error(`requirePlan: unknown plan "${minPlan}". Valid values: starter, pro`);
  }

  return function planGate(req, res, next) {
    const c = req.contractor;

    // Safety: requireAuth must always run first
    if (!c) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const now = new Date();

    // ── TRIAL IN PROGRESS — allow everything ──────────────────────────────────
    if (c.plan_status === 'trial' && c.trial_ends_at && new Date(c.trial_ends_at) > now) {
      return next();
    }

    // ── TRIAL EXPIRED ──────────────────────────────────────────────────────────
    if (c.plan_status === 'trial') {
      return res.status(403).json({
        error:       'trial_expired',
        message:     'Your 14-day trial has ended',
        upgrade_url: '/pricing',
      });
    }

    // ── ACTIVE SUBSCRIPTION ───────────────────────────────────────────────────
    if (c.plan_status === 'active') {
      const contractorRank = PLAN_RANK[c.plan] || 0;
      const requiredRank   = PLAN_RANK[minPlan];

      if (contractorRank >= requiredRank) {
        return next();
      }

      // Subscribed but plan tier is too low
      const planName = minPlan.charAt(0).toUpperCase() + minPlan.slice(1);
      return res.status(403).json({
        error:       'upgrade_required',
        message:     `This feature requires ${planName}`,
        upgrade_url: '/pricing',
      });
    }

    // ── INACTIVE / CANCELLED / UNKNOWN ────────────────────────────────────────
    return res.status(403).json({
      error:       'subscription_inactive',
      message:     'Your subscription is inactive',
      upgrade_url: '/pricing',
    });
  };
}

module.exports = { requirePlan };
