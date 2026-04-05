const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'hstratigies@gmail.com';
const FROM_EMAIL = 'onboarding@resend.dev';

if (!API_KEY) { console.log('\n❌ No API key.\n'); process.exit(1); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

console.log('\n✅ API key loaded');
console.log('✅ Resend email configured');
console.log('✅ Supabase admin client initialized');
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
    const pd = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{role:'user',content:prompt}] });
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
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px"><h1 style="color:#e8f5ec;font-size:20px;margin:0">You're all set, ${(lead.name||'').split(' ')[0]}!</h1></div><p style="color:#2c2c2a;font-size:14px;line-height:1.7">Thanks for reaching out. Here's a summary of your request:</p><div style="background:#f5f5f3;border-radius:8px;padding:16px;margin:16px 0"><table style="width:100%;font-size:13px;color:#2c2c2a"><tr><td style="color:#888;padding:4px 0;width:120px">Service</td><td style="font-weight:500">${lead.service||'—'}</td></tr><tr><td style="color:#888;padding:4px 0">Address</td><td style="font-weight:500">${lead.address||'—'}</td></tr><tr><td style="color:#888;padding:4px 0">Requested time</td><td style="font-weight:500">${lead.datetime||'—'}</td></tr></table></div><p style="color:#2c2c2a;font-size:14px;line-height:1.7">Jake will be in touch soon to lock in your exact time. Reply to this email if anything changes.</p><p style="color:#2c2c2a;font-size:14px;margin-top:20px">Talk soon,<br><strong>GreenPro Landscaping & Pest Control</strong></p></div>`;
}

async function saveLead(lead, source) {
  const { error } = await supabase.from('leads').insert({
    name: lead.name || null,
    phone: lead.phone || null,
    email: lead.email || null,
    address: lead.address || null,
    service: lead.service || null,
    datetime: lead.datetime || null,
    source,
    transcript: lead.transcript || null,
    created_at: new Date().toISOString()
  });
  if (error) console.error('Supabase insert error:', error.message);
  else console.log('Lead saved to Supabase');
}

// ── APP ──
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');
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
    await saveLead(lead, 'chat');
    if (lead.email) {
      await sendEmail(lead.email, `You're booked — ${lead.service} estimate confirmed`, confirmHTML(lead));
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

app.listen(PORT, () => {
  try { require('child_process').exec('open http://localhost:' + PORT + '/app'); } catch(e) {}
});
