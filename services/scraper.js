// services/scraper.js
// Website fetching + HTML cleaning utilities used by the onboarding scraper
// and the prospector tool.

const https = require('https');
const http  = require('http');

// ── HTML UTILITIES ───────────────────────────────────────────────────────────

function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 8000);
}

// ── PAGE FETCHERS ────────────────────────────────────────────────────────────

/**
 * Fetches a page as clean text (strips HTML). Used by the onboarding scraper.
 */
function fetchPage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadProBot/1.0)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        fetchPage(loc, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(stripHTML(data)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Fetches a page and returns raw HTML + final URL (after redirects).
 * Used by the prospector to check for chat widgets, SSL, viewport meta, etc.
 */
function fetchPageHTML(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadProBot/1.0)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        fetchPageHTML(loc, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let data = '', size = 0;
      res.on('data', c => { if (size < 150_000) { data += c; size += c.length; } });
      res.on('end', () => resolve({ html: data, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── CONTRACTOR WEBSITE ANALYSIS ──────────────────────────────────────────────

const KNOWN_CHAT_WIDGETS = [
  'intercom', 'drift.com', 'driftt.com', 'tidio', 'tawk.to', 'livechatinc',
  'livechat', 'zopim', 'zendesk', 'crisp.chat', 'freshchat', 'olark',
  'smartsupp', 'userlike', 'hubspot', 'hs-scripts.com', 'chaport', 'jivochat',
  'purechat', 'snapengage', 'liveagent', 'kayako', 'helpcrunch',
];
const GENERIC_CHAT_RE = /<script[^>]+src=["'][^"']*(?:chat|widget|messenger)[^"']*\.js[^"']*["']/i;
const PHONE_RE = /(?:tel:|href=["']tel:|\b)(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

function checkChatWidget(html) {
  const lower = html.toLowerCase();
  return KNOWN_CHAT_WIDGETS.some(p => lower.includes(p)) || GENERIC_CHAT_RE.test(html);
}

function checkPhoneNumber(html) {
  return PHONE_RE.test(html);
}

function checkWebsiteQuality(html, finalUrl) {
  const hasSSL            = finalUrl.startsWith('https://');
  const hasMobileViewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
  return { hasSSL, hasMobileViewport, score: (hasSSL ? 1 : 0) + (hasMobileViewport ? 1 : 0) };
}

function scoreContractor(analysis) {
  let score = 0;
  const missing = [];

  if (!analysis.hasWebsite) {
    score += 35;
    missing.push('No website');
  } else {
    if (!analysis.hasChatWidget) {
      score += 30;
      missing.push('No chat widget');
    }
    if (!analysis.hasSSL) {
      score += 10;
      missing.push('No SSL');
    }
    if (!analysis.hasMobileViewport) {
      score += 8;
      missing.push('No mobile viewport');
    }
  }

  if (!analysis.hasPhone) {
    score += 12;
    missing.push('No phone listed');
  }

  if (analysis.rating && analysis.rating < 4.0) {
    score += 5;
    missing.push('Low Google rating');
  }

  return { score: Math.min(score, 100), missing };
}

module.exports = { fetchPage, fetchPageHTML, checkChatWidget, checkPhoneNumber, checkWebsiteQuality, scoreContractor };
