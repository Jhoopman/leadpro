const CACHE_NAME = 'leadpro-v1';
const OFFLINE_URL = '/offline.html';

const APP_SHELL = [
  '/app',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LeadPro — Offline</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0A0A0A; color: #ffffff; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  .icon { width: 64px; height: 64px; background: rgba(45,106,79,0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
  .icon svg { width: 30px; height: 30px; fill: #74C69D; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 10px; }
  p { font-size: 14px; color: #666666; line-height: 1.6; max-width: 280px; margin: 0 auto 28px; }
  button { padding: 12px 28px; background: #2D6A4F; color: #fff; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
  button:active { opacity: 0.8; }
</style>
</head>
<body>
  <div>
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
    </div>
    <h1>You're offline</h1>
    <p>Check your connection and try again. LeadPro needs internet to sync your leads and appointments.</p>
    <button onclick="location.reload()">Try again</button>
  </div>
</body>
</html>`;

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache app shell, skip CDN failures gracefully
      return Promise.allSettled(
        APP_SHELL.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  // Skip non-GET and non-http requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // Skip Supabase API calls — always need live data
  if (event.request.url.includes('supabase.co')) return;
  if (event.request.url.includes('stripe.com')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for app shell assets
        if (response.ok && (
          event.request.url.includes('/app') ||
          event.request.url.includes('cdn.jsdelivr.net')
        )) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Try cache first
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // For navigation requests, return offline page
          if (event.request.mode === 'navigate') {
            return new Response(OFFLINE_HTML, {
              headers: { 'Content-Type': 'text/html' }
            });
          }
        });
      })
  );
});
