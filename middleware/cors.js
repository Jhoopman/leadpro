// middleware/cors.js
// Dynamic CORS allowlist with three sources:
//   A) LeadPro core origins (hardcoded)
//   B) Contractor widget domains (loaded from Supabase, cached 5 min TTL)
//   C) Public endpoints (/widget.js etc.) that must stay open to all origins

// TODO: expose POST /admin/cors-cache/refresh (protected by ADMIN_TOKEN env var)
//       and call it from the contractor update route whenever widget_domain changes.

const supabase = require('../services/supabase');

// A) Always-allowed origins
const CORE_ORIGINS = [
  'https://useleadpro.net',
  'https://www.useleadpro.net',
  'https://app.useleadpro.net',
  'https://leadpro-1d5l.onrender.com',
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://localhost:5173']
    : []),
];

// C) Paths that are legitimately fetched from arbitrary origins
const PUBLIC_PATHS = new Set([
  '/widget.js',
  '/widget-chat.html',
  '/config',
  '/manifest.json',
  '/service-worker.js',
]);

// In-memory cache for contractor domains (5-minute TTL)
let domainCache = { rows: [], expiresAt: 0 };

async function getContractorDomains() {
  const now = Date.now();
  if (now < domainCache.expiresAt) return domainCache.rows;

  try {
    const { data, error } = await supabase
      .from('contractors')
      .select('id, widget_domain')
      .not('widget_domain', 'is', null)
      .neq('widget_domain', '');

    if (error) {
      console.error('[CORS] Failed to load contractor domains:', error.message);
      return domainCache.rows; // serve stale data rather than lock everyone out
    }

    domainCache = { rows: data || [], expiresAt: now + 5 * 60 * 1000 };
    return domainCache.rows;
  } catch (e) {
    console.error('[CORS] Exception loading contractor domains:', e.message);
    return domainCache.rows;
  }
}

// Force cache refresh (called by admin endpoint or contractor-update route)
function invalidateDomainCache() {
  domainCache.expiresAt = 0;
}

// Strip protocol + trailing slash for apples-to-apples host comparison
function toHost(url) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

async function resolveOrigin(origin) {
  // A) Core origins
  if (CORE_ORIGINS.includes(origin)) return { allowed: true };

  // B) Contractor domains
  const host = toHost(origin);
  const rows = await getContractorDomains();

  for (const row of rows) {
    const domain = toHost(row.widget_domain);
    // Match both bare domain and www. variant stored or requested
    if (host === domain || host === `www.${domain}` || `www.${host}` === domain) {
      return { allowed: true, contractorId: row.id };
    }
  }

  return { allowed: false };
}

function corsMiddleware(req, res, next) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Key');

  // C) Public paths — open to the world
  if (PUBLIC_PATHS.has(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    return next();
  }

  const origin = req.headers.origin;

  // No Origin header = server-to-server (Stripe webhooks, curl, Postman) — allow
  if (!origin) {
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    return next();
  }

  // 'null' origin = file:// (desktop Marketing Hub). Allow only when the
  // request carries X-Internal-Key (actual request) or declares it in the
  // preflight Access-Control-Request-Headers. The route-level bypass still
  // validates the key value; CORS just needs to let the request through.
  if (origin === 'null') {
    const hasKey = req.headers['x-internal-key'] ||
      (req.headers['access-control-request-headers'] || '').toLowerCase().includes('x-internal-key');
    if (hasKey) {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      return next();
    }
    console.warn(`[CORS] REJECTED null-origin without internal key path=${req.path}`);
    return res.status(403).json({ error: 'Origin not allowed', origin });
  }

  resolveOrigin(origin)
    .then(({ allowed, contractorId }) => {
      if (allowed) {
        if (contractorId) {
          console.debug(
            `[CORS] ALLOWED contractor-domain origin=${origin} contractor_id=${contractorId}`,
          );
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
        next();
      } else {
        const ts = new Date().toISOString();
        console.warn(`[CORS] REJECTED origin=${origin} path=${req.path} ts=${ts}`);
        res.status(403).json({ error: 'Origin not allowed', origin });
      }
    })
    .catch(err => {
      console.error('[CORS] Middleware error:', err.message);
      next(err);
    });
}

module.exports = { corsMiddleware, invalidateDomainCache };
