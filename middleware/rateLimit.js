// middleware/rateLimit.js
// Simple in-memory rate limiter — no external dependency needed for a single Render instance.
// Swap for 'express-rate-limit' + Redis if you ever run multiple instances.
//
// Usage:
//   const { widgetLimit, apiLimit } = require('../middleware/rateLimit');
//   router.post('/widget-api', widgetLimit, handler);

const limiters = new Map();

/**
 * Factory — creates an Express middleware that limits requests per IP.
 * @param {object} opts
 * @param {number} opts.maxRequests  Max requests allowed in the window.
 * @param {number} opts.windowMs     Window length in milliseconds.
 * @param {string} [opts.message]    Error message returned on 429.
 */
function createLimiter({ maxRequests, windowMs, message = 'Too many requests — try again shortly.' }) {
  // ip → { count, resetAt }
  const store = new Map();

  // Clean up stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of store) {
      if (data.resetAt < now) store.delete(ip);
    }
  }, 5 * 60 * 1000);

  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = store.get(ip) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count  = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    store.set(ip, entry);

    res.setHeader('X-RateLimit-Limit',     maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));

    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

// ── PREBUILT LIMITERS ────────────────────────────────────────────────────────

// Widget chat: public-facing, hits Claude API — protect aggressively
const widgetLimit = createLimiter({ maxRequests: 30,  windowMs: 60_000 });

// General API: authenticated routes
const apiLimit    = createLimiter({ maxRequests: 120, windowMs: 60_000 });

// Prospector: expensive (Google Places + web scraping), limit tightly
const prospectorLimit = createLimiter({ maxRequests: 10, windowMs: 60_000 });

// Auth endpoints: prevent brute force
const authLimit   = createLimiter({ maxRequests: 10,  windowMs: 60_000 });

module.exports = { createLimiter, widgetLimit, apiLimit, prospectorLimit, authLimit };
