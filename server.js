require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'hstratigies@gmail.com';
const FROM_EMAIL = 'onboarding@resend.dev';
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY      || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET  || '';
const STRIPE_STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID || '';
const STRIPE_PRO_PRICE_ID    = process.env.STRIPE_PRO_PRICE_ID    || '';
const GOOGLE_PLACES_API_KEY  = process.env.GOOGLE_PLACES_API_KEY  || '';

/*
  Supabase migration — run once in the SQL editor:
  ALTER TABLE contractors
    ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
    ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
    ADD COLUMN IF NOT EXISTS plan                   text DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS plan_status            text DEFAULT 'trial',
    ADD COLUMN IF NOT EXISTS trial_ends_at          timestamptz;
*/

if (!API_KEY) { console.log('\n❌ No API key.\n'); process.exit(1); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n✅ API key loaded');
console.log('✅ Resend email configured');
console.log('✅ Supabase admin client initialized');
if (STRIPE_SECRET_KEY) console.log('✅ Stripe billing configured');
else console.log('⚠️  No STRIPE_SECRET_KEY — billing endpoints disabled');
if (GOOGLE_PLACES_API_KEY) console.log('✅ Google Places API configured');
else console.log('⚠️  No GOOGLE_PLACES_API_KEY — prospector endpoint disabled');
console.log('✅ LeadPro server running on port', PORT, '\n');

// ── HELPERS ──
function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from: `LeadPro <${FROM_EMAIL}>`, to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,data:d})); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s{2,}/g,' ').trim().slice(0,8000);
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: {'User-Agent':'Mozilla/5.0 (compatible; LeadProBot/1.0)'} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        fetchPage(loc).then(resolve).catch(reject); return;
      }
      let data = ''; res.on('data',c=>data+=c); res.on('end',()=>resolve(stripHTML(data)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function claudeExtract(pageText) {
  return new Promise((resolve, reject) => {
    const prompt = `Analyze this contractor website content and extract what an AI receptionist needs to answer customer questions accurately.

Website content:
${pageText}

Return ONLY a JSON object with these fields (null if not found):
{
  "business_name": "exact business name",
  "owner_name": "owner name if mentioned",
  "services": ["list", "of", "services"],
  "service_area": "cities or areas served",
  "hours": "business hours if mentioned",
  "pricing_notes": "any pricing info or free estimates mention",
  "about": "1 sentence about the business",
  "specialties": "what they emphasize as their differentiator"
}`;
    const pd = JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:600, messages:[{role:'user',content:prompt}] });
    const req = https.request({
      hostname:'api.anthropic.com', port:443, path:'/v1/messages', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(pd),'x-api-key':API_KEY,'anthropic-version':'2023-06-01'}
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try { const p=JSON.parse(d); const t=p.content?.[0]?.text||'{}'; resolve(JSON.parse(t.replace(/```json|```/g,'').trim())); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject); req.write(pd); req.end();
  });
}

function leadAlertHTML(lead, source) {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px"><h1 style="color:#e8f5ec;font-size:18px;margin:0">New lead — ${source}</h1><p style="color:#7db896;font-size:13px;margin:6px 0 0">LeadPro AI alert</p></div><div style="background:#f5f5f3;border-radius:8px;padding:16px"><table style="width:100%;font-size:13px;color:#2c2c2a"><tr><td style="color:#888;padding:5px 0;width:110px">Name</td><td style="font-weight:500">${lead.name||'—'}</td></tr><tr><td style="color:#888;padding:5px 0">Phone</td><td style="font-weight:500">${lead.phone||'—'}</td></tr><tr><td style="color:#888;padding:5px 0">Email</td><td style="font-weight:500">${lead.email||'—'}</td></tr><tr><td style="color:#888;padding:5px 0">Service</td><td style="font-weight:500">${lead.service||'—'}</td></tr><tr><td style="color:#888;padding:5px 0">Address</td><td style="font-weight:500">${lead.address||'—'}</td></tr><tr><td style="color:#888;padding:5px 0">Requested</td><td style="font-weight:500">${lead.datetime||'—'}</td></tr></table></div><p style="color:#888;font-size:12px;margin-top:16px">View dashboard: <a href="https://leadpro-1d5l.onrender.com/app" style="color:#2d7a4e">leadpro-1d5l.onrender.com/app</a></p></div>`;
}

function confirmHTML(lead) {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px"><h1 style="color:#e8f5ec;font-size:20px;margin:0">You're all set, ${(lead.name||'').split(' ')[0]}!</h1></div><p style="color:#2c2c2a;font-size:14px;line-height:1.7">Thanks for reaching out. Here's a summary of your request:</p><div style="background:#f5f5f3;border-radius:8px;padding:16px;margin:16px 0"><table style="width:100%;font-size:13px;color:#2c2c2a"><tr><td style="color:#888;padding:4px 0;width:120px">Service</td><td style="font-weight:500">${lead.service||'—'}</td></tr><tr><td style="color:#888;padding:4px 0">Address</td><td style="font-weight:500">${lead.address||'—'}</td></tr><tr><td style="color:#888;padding:4px 0">Requested time</td><td style="font-weight:500">${lead.datetime||'—'}</td></tr></table></div><p style="color:#2c2c2a;font-size:14px;line-height:1.7">Our team will be in touch soon to lock in your exact time. Reply to this email if anything changes.</p><p style="color:#2c2c2a;font-size:14px;margin-top:20px">Talk soon,<br><strong>${lead.bizName||'Our Team'}</strong></p></div>`;
}

async function saveLead(lead, source) {
  if (!lead.contractor_id) {
    console.warn('saveLead: no contractor_id — skipping Supabase insert');
    return;
  }
  const notes = [lead.datetime, lead.transcript ? lead.transcript.slice(0, 500) : null]
    .filter(Boolean).join(' | ');
  const { error } = await supabase.from('leads').insert({
    contractor_id: lead.contractor_id,
    name: lead.name || '',
    phone: lead.phone || '',
    address: lead.address || '',
    service: lead.service || '',
    notes: notes || '',
    status: 'new'
  });
  if (error) console.error('Supabase insert error:', error.message);
  else console.log('Lead saved to Supabase');
}

// ── STRIPE HELPERS ──
// Flattens nested objects into Stripe's form-encoded key format
// e.g. { line_items: [{ price: 'p', quantity: 1 }] }
//   -> { 'line_items[0][price]': 'p', 'line_items[0][quantity]': '1' }
function flattenStripeParams(obj, prefix) {
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

function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const flat  = params ? flattenStripeParams(params) : {};
    const body  = new URLSearchParams(flat).toString();
    const req = https.request({
      hostname: 'api.stripe.com', port: 443,
      path: '/v1/' + path, method,
      headers: {
        'Authorization':  'Bearer ' + STRIPE_SECRET_KEY,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function verifyStripeSignature(rawBody, sigHeader) {
  const parts  = sigHeader.split(',');
  const tsPart = parts.find(p => p.startsWith('t='));
  const sigPart = parts.find(p => p.startsWith('v1='));
  if (!tsPart || !sigPart) throw new Error('Invalid Stripe-Signature header');
  const ts  = tsPart.slice(2);
  const sig = sigPart.slice(3);
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(ts + '.' + rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')))
    throw new Error('Stripe signature mismatch');
}

// ── PROSPECTOR HELPERS ──
function fetchPageHTML(url, redirectCount) {
  redirectCount = redirectCount || 0;
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadProBot/1.0)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        fetchPageHTML(loc, redirectCount + 1).then(resolve).catch(reject); return;
      }
      let data = '', size = 0;
      res.on('data', c => { if (size < 150000) { data += c; size += c.length; } });
      res.on('end', () => resolve({ html: data, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function googlePlacesRequest(apiPath) {
  return new Promise((resolve, reject) => {
    https.get('https://maps.googleapis.com/maps/api/place/' + apiPath, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function checkChatWidget(html) {
  const lower = html.toLowerCase();
  const knownWidgets = [
    'intercom', 'drift.com', 'driftt.com', 'tidio', 'tawk.to', 'livechatinc',
    'livechat', 'zopim', 'zendesk', 'crisp.chat', 'freshchat', 'olark',
    'smartsupp', 'userlike', 'hubspot', 'hs-scripts.com', 'chaport', 'jivochat',
    'purechat', 'snapengage', 'liveagent', 'kayako', 'helpcrunch'
  ];
  if (knownWidgets.some(p => lower.includes(p))) return true;
  // Generic: any script src containing "chat" or "widget"
  const genericChat = /<script[^>]+src=["'][^"']*(?:chat|widget|messenger)[^"']*\.js[^"']*["']/i;
  return genericChat.test(html);
}

function checkPhoneNumber(html) {
  // US phone number pattern in visible text or href="tel:..."
  return /(?:tel:|href=["']tel:|\b)(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/.test(html);
}

function checkWebsiteQuality(html, finalUrl) {
  const hasSSL = finalUrl.startsWith('https://');
  const hasMobileViewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(html);
  return { hasSSL, hasMobileViewport, score: (hasSSL ? 1 : 0) + (hasMobileViewport ? 1 : 0) };
}

function scoreContractor(analysis) {
  let score = 0;
  const missing = [];
  if (!analysis.hasWebsite)    { score += 40; missing.push('No website'); }
  if (!analysis.hasChatWidget) { score += 25; missing.push('No chat widget'); }
  if (analysis.hasWebsite && analysis.websiteQualityScore < 2) { score += 15; missing.push('Poor website quality'); }
  if (!analysis.hasPhone)      { score += 20; missing.push('No phone listed'); }
  return { score: Math.min(score, 100), missing };
}

// ── APP ──
const app = express();
// Capture raw body for Stripe webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => { if (req.path === '/stripe-webhook') req.rawBody = buf; }
}));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// Static files
app.get('/widget.js', (req, res) => res.sendFile(path.join(__dirname, 'widget.js')));
app.get('/widget-chat.html', (req, res) => res.sendFile(path.join(__dirname, 'widget-chat.html')));

// Supabase config for client-side
app.get('/config', (req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  res.json({
    supabaseUrl,
    supabaseAnonKey,
    configured: !!(supabaseUrl && supabaseAnonKey)
  });
});

// Serve HTML app
app.get(['/', '/app'], (req, res) => {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.html') && f !== 'widget-chat.html');
  if (!files.length) { res.status(404).send('No HTML found'); return; }
  res.sendFile(path.join(__dirname, files[0]));
});

// Contractor profile by widget ID (used by embedded widget)
app.get('/contractor/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contractors')
      .select('id, business_name, services')
      .eq('widget_id', req.params.id)
      .single();
    if (error || !data) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Widget chat API — builds personalized system prompt from contractor data
app.post('/widget-api', (req, res) => {
  const { messages, bizName, services } = req.body;
  if (!messages) { res.status(400).json({ error: 'No messages' }); return; }
  const biz = bizName || 'our company';
  const svcList = services || 'general services';
  const systemPrompt = `You are a friendly scheduling assistant for ${biz}. Your job is to have a warm, natural conversation to gather info and book an appointment or estimate.

Services offered: ${svcList}

Goals:
1. Greet the customer warmly and ask how you can help
2. Naturally collect these 5 things (one at a time): name, phone number, address/zip code, service needed, preferred date and time
3. Confirm all details back to them warmly
4. Tell them the team will follow up to confirm within a few hours

Rules:
- Sound human and conversational — no bullet lists, no robotic tone
- Ask one question at a time
- Keep responses SHORT — 1-3 sentences max
- Once you have all 5 fields, output this ONCE at the END of your message:
LEAD_DATA:{"name":"...","phone":"...","address":"...","service":"...","datetime":"..."}`;
  const pd = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, system: systemPrompt, messages });
  const proxyReq = https.request({
    hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd), 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
  }, proxyRes => {
    let d = ''; proxyRes.on('data', c => d += c);
    proxyRes.on('end', () => { res.status(proxyRes.statusCode).json(JSON.parse(d)); });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.write(pd); proxyReq.end();
});

// Claude API proxy
app.post('/api', (req, res) => {
  const pd = JSON.stringify(req.body);
  const proxyReq = https.request({
    hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd), 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' }
  }, proxyRes => {
    let d = ''; proxyRes.on('data', c => d += c);
    proxyRes.on('end', () => { res.status(proxyRes.statusCode).json(JSON.parse(d)); });
  });
  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.write(pd); proxyReq.end();
});

// Website scraper
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) { res.status(400).json({ error: 'No URL' }); return; }
  console.log('Scraping:', url);
  try {
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const pageText = await fetchPage(fullUrl);
    const profile = await claudeExtract(pageText);
    console.log('Profile extracted:', profile?.business_name || 'unknown');
    res.json({ success: true, profile });
  } catch (e) {
    console.error('Scrape error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat lead confirmation
app.post('/send-confirmation', async (req, res) => {
  const lead = req.body;
  try {
    let bizName = lead.bizName || 'Our Team';
    const contractorId = lead.contractorId || null;
    if (contractorId && !lead.bizName) {
      const { data } = await supabase.from('contractors').select('business_name').eq('id', contractorId).single();
      if (data) bizName = data.business_name;
    }
    await saveLead({ ...lead, contractor_id: contractorId }, 'chat');
    if (lead.email) {
      await sendEmail(lead.email, `You're booked — ${lead.service} estimate confirmed`, confirmHTML({ ...lead, bizName }));
      console.log('Customer email sent:', lead.email);
    }
    await sendEmail(ALERT_EMAIL, `New chat lead: ${lead.name} — ${lead.service}`, leadAlertHTML(lead, 'Website chat'));
    console.log('Alert email sent');
    res.json({ success: true });
  } catch (e) {
    console.error('Email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Vapi phone webhook
app.post('/vapi-webhook', async (req, res) => {
  res.json({ received: true });
  const payload = req.body;
  const msg = payload.message || payload;
  if ((msg.type || payload.type) !== 'end-of-call-report') return;
  console.log('\nPhone call ended — processing lead...');
  const s = msg.structuredData || {};
  const call = msg.call || {};
  const lead = {
    name: s.name || 'Unknown caller',
    phone: s.phone || call.customer?.number || '—',
    email: s.email || null,
    address: s.address || '—',
    service: s.service || '—',
    datetime: s.datetime || '—',
    transcript: msg.transcript || ''
  };
  try {
    await saveLead(lead, 'phone');
    await sendEmail(ALERT_EMAIL, `New PHONE lead: ${lead.name} — ${lead.service}`,
      leadAlertHTML(lead, 'Phone call') +
      `<div style="margin-top:16px;background:#f5f5f3;border-radius:8px;padding:14px"><div style="font-size:11px;color:#888;margin-bottom:8px">CALL TRANSCRIPT</div><div style="font-size:12px;color:#2c2c2a;line-height:1.7;white-space:pre-wrap">${lead.transcript.slice(0,1000)}</div></div>`
    );
    if (lead.email) await sendEmail(lead.email, `Thanks for calling — ${lead.service} estimate requested`, confirmHTML(lead));
    console.log('Phone lead emails sent');
  } catch (e) { console.error('Phone email error:', e.message); }
});

// ── STRIPE BILLING ──

// POST /ensure-contractor — create contractor row via service key if it doesn't exist
// Called from frontend after signup (RLS blocks anon insert when email confirmation is pending)
// and from afterLogin as a safety net for users whose row was never created.
app.post('/ensure-contractor', async (req, res) => {
  const { userId, businessName } = req.body;
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
  try {
    const { data: existing } = await supabase
      .from('contractors').select('id').eq('id', userId).limit(1);
    if (existing?.[0]) { res.json({ created: false }); return; }

    const widgetId = 'lp_' + Math.random().toString(36).substr(2, 8);
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 14);
    const { error } = await supabase.from('contractors').insert({
      id: userId,
      business_name: businessName || '',
      widget_id: widgetId,
      plan: 'free',
      plan_status: 'trial',
      trial_ends_at: trialEnds.toISOString()
    });
    if (error) throw new Error(error.message);
    res.json({ created: true });
  } catch(e) {
    console.error('ensure-contractor error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /create-checkout-session — start Stripe Checkout for a plan
app.post('/create-checkout-session', async (req, res) => {
  if (!STRIPE_SECRET_KEY) { res.status(503).json({ error: 'Billing not configured' }); return; }
  const { plan, contractorId, successUrl, cancelUrl } = req.body;
  if (!plan || !contractorId) { res.status(400).json({ error: 'Missing plan or contractorId' }); return; }
  const priceId = plan === 'pro' ? STRIPE_PRO_PRICE_ID : STRIPE_STARTER_PRICE_ID;
  if (!priceId) { res.status(503).json({ error: 'Price ID not configured for plan: ' + plan }); return; }
  try {
    const { data: rows, error: dbErr } = await supabase
      .from('contractors').select('id, business_name, stripe_customer_id').eq('id', contractorId).limit(1);
    if (dbErr) {
      console.error('Supabase lookup error for contractorId', contractorId, ':', dbErr.message);
      res.status(500).json({ error: 'Database error: ' + dbErr.message }); return;
    }
    const contractor = rows?.[0];
    if (!contractor) { res.status(404).json({ error: 'Contractor not found for id: ' + contractorId }); return; }

    let customerId = contractor.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeRequest('POST', 'customers', {
        description: contractor.business_name,
        metadata: { contractor_id: contractorId }
      });
      if (customer.error) throw new Error(customer.error.message);
      customerId = customer.id;
      await supabase.from('contractors').update({ stripe_customer_id: customerId }).eq('id', contractorId);
    }

    const session = await stripeRequest('POST', 'checkout/sessions', {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || 'https://leadpro-1d5l.onrender.com/app?billing=success',
      cancel_url:  cancelUrl  || 'https://leadpro-1d5l.onrender.com/app',
      metadata: { contractor_id: contractorId, plan }
    });
    if (session.error) throw new Error(session.error.message);
    res.json({ url: session.url });
  } catch(e) {
    console.error('Checkout session error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /stripe-webhook — handle Stripe events
app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig || !req.rawBody) { res.status(400).json({ error: 'Missing signature or raw body' }); return; }
  if (!STRIPE_WEBHOOK_SECRET) { res.status(503).json({ error: 'Webhook secret not configured' }); return; }
  try {
    verifyStripeSignature(req.rawBody.toString(), sig);
  } catch(e) {
    console.warn('Stripe webhook rejected:', e.message);
    res.status(400).json({ error: 'Invalid signature' }); return;
  }
  const event = req.body;
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const contractorId = session.metadata?.contractor_id;
      const plan = session.metadata?.plan || 'starter';
      if (contractorId) {
        await supabase.from('contractors').update({
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          plan,
          plan_status: 'active'
        }).eq('id', contractorId);
        console.log('Subscription activated — contractor:', contractorId, 'plan:', plan);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { data } = await supabase.from('contractors')
        .select('id').eq('stripe_subscription_id', sub.id).single();
      if (data) {
        await supabase.from('contractors').update({
          plan_status: 'inactive',
          stripe_subscription_id: null
        }).eq('id', data.id);
        console.log('Subscription cancelled — contractor:', data.id);
      }
    }
    res.json({ received: true });
  } catch(e) {
    console.error('Webhook processing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /billing-portal — open Stripe Customer Portal
app.get('/billing-portal', async (req, res) => {
  if (!STRIPE_SECRET_KEY) { res.status(503).json({ error: 'Billing not configured' }); return; }
  const contractorId = req.query.contractorId;
  if (!contractorId) { res.status(400).json({ error: 'Missing contractorId' }); return; }
  try {
    const { data: contractor } = await supabase
      .from('contractors').select('stripe_customer_id').eq('id', contractorId).single();
    if (!contractor?.stripe_customer_id) {
      res.status(404).json({ error: 'No billing account found — subscribe first' }); return;
    }
    const portal = await stripeRequest('POST', 'billing_portal/sessions', {
      customer:   contractor.stripe_customer_id,
      return_url: 'https://leadpro-1d5l.onrender.com/app'
    });
    if (portal.error) throw new Error(portal.error.message);
    res.json({ url: portal.url });
  } catch(e) {
    console.error('Billing portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve prospector tool
app.get('/prospector', (req, res) => res.sendFile(path.join(__dirname, 'prospector.html')));

// POST /api/prospector — find and score contractors via Google Places
app.post('/api/prospector', async (req, res) => {
  if (!GOOGLE_PLACES_API_KEY) {
    res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured on server' }); return;
  }
  const { location, industry } = req.body;
  if (!location || !industry) { res.status(400).json({ error: 'Missing location or industry' }); return; }

  console.log('[prospector] API key prefix:', GOOGLE_PLACES_API_KEY.slice(0, 20));

  try {
    const query = encodeURIComponent(`${industry} contractors in ${location}`);
    const searchRes = await googlePlacesRequest(
      `textsearch/json?query=${query}&type=establishment&key=${GOOGLE_PLACES_API_KEY}`
    );
    console.log('[prospector] Google Places textsearch response:', JSON.stringify(searchRes, null, 2));
    if (searchRes.status !== 'OK' && searchRes.status !== 'ZERO_RESULTS') {
      res.status(500).json({ error: 'Places API: ' + searchRes.status, details: searchRes.error_message }); return;
    }

    const places = (searchRes.results || []).slice(0, 10);
    const results = [];

    for (const place of places) {
      let name = place.name;
      let phone = null;
      let website = null;
      let address = place.formatted_address || '';

      try {
        const detailRes = await googlePlacesRequest(
          `details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address&key=${GOOGLE_PLACES_API_KEY}`
        );
        const d = detailRes.result || {};
        name    = d.name    || name;
        phone   = d.formatted_phone_number || null;
        website = d.website || null;
        address = d.formatted_address || address;
      } catch(e) {
        console.log('Places detail error for', place.place_id, ':', e.message);
      }

      const analysis = { hasWebsite: !!website, hasChatWidget: false, hasPhone: !!phone, websiteQualityScore: 0, hasSSL: false, hasMobileViewport: false };

      if (website) {
        try {
          const { html, finalUrl } = await fetchPageHTML(website.startsWith('http') ? website : 'https://' + website);
          analysis.hasChatWidget = checkChatWidget(html);
          if (!analysis.hasPhone) analysis.hasPhone = checkPhoneNumber(html);
          const quality = checkWebsiteQuality(html, finalUrl);
          analysis.websiteQualityScore = quality.score;
          analysis.hasSSL = quality.hasSSL;
          analysis.hasMobileViewport = quality.hasMobileViewport;
        } catch(e) {
          console.log('Website fetch error for', website, ':', e.message);
        }
      }

      const { score, missing } = scoreContractor(analysis);

      results.push({
        name, phone, website, address, score, missing,
        hasChatWidget:    analysis.hasChatWidget,
        hasWebsite:       analysis.hasWebsite,
        hasPhone:         analysis.hasPhone,
        hasSSL:           analysis.hasSSL,
        hasMobileViewport: analysis.hasMobileViewport
      });
    }

    results.sort((a, b) => b.score - a.score);
    console.log(`Prospector: found ${results.length} results for "${industry}" in "${location}"`);
    res.json({ results });
  } catch(e) {
    console.error('Prospector error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  try { require('child_process').exec('open http://localhost:' + PORT + '/app'); } catch(e) {}
});
