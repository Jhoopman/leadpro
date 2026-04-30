// routes/agent.js
// Handles all AI agent interactions:
//   POST /widget-api       — widget chat (contractor scheduling + LeadPro marketing)
//   POST /api              — raw Claude API proxy (dashboard internal use)
//   POST /vapi-webhook     — Vapi phone call end-of-call report
//   POST /send-confirmation — send confirmation email after chat lead captured
//   POST /scrape           — scrape contractor website during onboarding

const express   = require('express');
const router    = express.Router();
const https     = require('https');
const supabase  = require('../services/supabase');
const claude    = require('../services/claude');
const email     = require('../services/email');
const { sendContractorSms }    = require('./twilio');
const { formatSlotsForPrompt } = require('../services/calendar');
const { catchAsync }           = require('../middleware/errorHandler');
const { widgetLimit, apiLimit, scrapeLimit } = require('../middleware/rateLimit');
const cfg       = require('../config');

const MARKETING_WIDGET_ID = 'lp_rdzvuqld';
const CLAUDE_MODEL        = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const MARKETING_SYSTEM_PROMPT = `You are a sales assistant for LeadPro, AI lead generation software for contractors. Never ask for addresses, zip codes, or schedule appointments. You sell software. Answer pricing questions: Starter $97/month, Pro $197/month, 14 day free trial no credit card. Collect name, email, phone number only. Direct them to app.useleadpro.net to start their free trial. Keep responses clean and professional. No emojis. No bold markdown formatting. Write in plain conversational sentences like a real person texting, not a marketing bot. Keep responses short — 3-4 sentences max per reply.`;

// ── HELPERS ──────────────────────────────────────────────────────────────────

async function saveLead(lead, source) {
  if (!lead.contractor_id) {
    console.warn('saveLead: no contractor_id — skipping Supabase insert');
    return;
  }
  const notes = [lead.datetime, lead.transcript ? lead.transcript.slice(0, 500) : null]
    .filter(Boolean).join(' | ');

  const { error } = await supabase.from('leads').insert({
    contractor_id: lead.contractor_id,
    name:          lead.name    || '',
    phone:         lead.phone   || '',
    address:       lead.address || '',
    service:       lead.service || '',
    notes:         notes || '',
    status:        'new',
  });

  if (error) console.error('[saveLead] Supabase error:', error.message);
  else       console.log('[saveLead] Lead saved — contractor:', lead.contractor_id);
}

// Pipes a Claude API request body directly to Anthropic and mirrors the response.
// Used by the raw /api proxy and the widget routes.
function proxyToAnthropic(payloadStr, res) {
  const req = https.request({
    hostname: 'api.anthropic.com',
    port:     443,
    path:     '/v1/messages',
    method:   'POST',
    headers:  {
      'Content-Type':       'application/json',
      'Content-Length':     Buffer.byteLength(payloadStr),
      'x-api-key':          cfg.anthropicApiKey,
      'anthropic-version':  '2023-06-01',
    },
  }, proxyRes => {
    let d = '';
    proxyRes.on('data', c => d += c);
    proxyRes.on('end', () => {
      try   { res.status(proxyRes.statusCode).json(JSON.parse(d)); }
      catch (e) { res.status(500).json({ error: 'Claude API parse error' }); }
    });
  });
  req.on('error', e => res.status(500).json({ error: e.message }));
  req.write(payloadStr);
  req.end();
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// POST /widget-api — AI chat for embedded widget
router.post('/widget-api', widgetLimit, (req, res) => {
  const { messages, widgetId, bizName, services, availableSlots } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages provided' });

  // LeadPro marketing widget or undefined/empty widgetId → use marketing prompt
  if (!widgetId || widgetId === MARKETING_WIDGET_ID) {
    const pd = JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 500,
      system:     MARKETING_SYSTEM_PROMPT,
      messages,
    });
    return proxyToAnthropic(pd, res);
  }

  // Contractor scheduling widget
  const biz      = bizName  || 'our company';
  const svcList  = services || 'general services';
  const slotText = formatSlotsForPrompt(availableSlots);

  const systemPrompt = slotText
    ? // Calendar connected — offer real slots
      `You are a friendly scheduling assistant for ${biz}.
You help customers book appointments fast — like a helpful
office manager who texts, not a robot.

Services: ${svcList}

Available slots (offer ONLY these times):
${slotText}

Your exact flow — one message at a time:
1. Warm greeting + ask what they need help with
2. Ask for their name
3. Ask for their phone number
4. Ask for their address or zip code
5. Offer the available time slots — let them pick
6. Confirm everything back in one clean message
7. Tell them they'll get a confirmation text

Rules:
- One question per message. Never stack two questions.
- Keep every reply under 2 sentences.
- If they ask about price say: "We offer free estimates —
  no cost to have us come take a look."
- If they say it's an emergency say: "Got it — I'm flagging
  this as urgent. What's the best number to reach you right now?"
- If they ask "is this a bot?" say: "I'm an automated assistant
  for ${biz} — a real person will follow up to confirm."
- Never suggest times not in the list above.
- Sound local and human. No corporate language.

When you have: name, phone, address, service, and a chosen slot —
output this ONCE at the very end of your final message:
LEAD_DATA:{"name":"...","phone":"...","email":"","address":"...","service":"...","datetime":"...","slot_start":"ISO8601","slot_end":"ISO8601"}`

    : // No calendar — collect preferred time as free text
      `You are a friendly scheduling assistant for ${biz}.
You help customers request appointments — warm, fast, local.

Services: ${svcList}

Your exact flow — one message at a time:
1. Warm greeting + ask what they need help with
2. Ask for their name
3. Ask for their phone number
4. Ask for their address or zip code
5. Ask what day and time works best for them
6. Confirm everything back in one clean message
7. Tell them the team will reach out within 2 hours to confirm

Rules:
- One question per message. Never stack two questions.
- Keep every reply under 2 sentences.
- If they ask about price say: "We offer free estimates —
  no cost to have us come take a look."
- If they say it's an emergency say: "Got it — I'm flagging
  this as urgent. What's the best number to reach you right now?"
- If they ask "is this a bot?" say: "I'm an automated assistant
  for ${biz} — a real person will follow up shortly."
- Sound local and human. No corporate language.

When you have: name, phone, address, service, and preferred time —
output this ONCE at the very end of your final message:
LEAD_DATA:{"name":"...","phone":"...","email":"","address":"...","service":"...","datetime":"..."}`;

  const pd = JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 500, system: systemPrompt, messages });
  proxyToAnthropic(pd, res);
});

// POST /api — raw Claude API proxy (used by dashboard internals)
router.post('/api', apiLimit, (req, res) => {
  const pd = JSON.stringify(req.body);
  proxyToAnthropic(pd, res);
});

// POST /scrape — scrape contractor website during onboarding
router.post('/scrape', scrapeLimit, catchAsync(async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const fullUrl   = url.startsWith('http') ? url : 'https://' + url;
  const { fetchPage } = require('../services/scraper');
  const pageText  = await fetchPage(fullUrl);
  const profile   = await claude.extractContractorProfile(pageText);
  res.json({ success: true, profile });
}));

// POST /send-confirmation — chat widget calls this when LEAD_DATA is captured
router.post('/send-confirmation', catchAsync(async (req, res) => {
  const lead         = req.body;
  const contractorId = lead.contractorId || null;

  let bizName = lead.bizName || 'Our Team';
  if (contractorId && !lead.bizName) {
    const { data } = await supabase
      .from('contractors')
      .select('business_name')
      .eq('id', contractorId)
      .single();
    if (data) bizName = data.business_name;
  }

  await saveLead({ ...lead, contractor_id: contractorId }, 'chat');
  await email.sendConfirmation({ ...lead, bizName });
  await email.sendLeadAlert({ ...lead, bizName }, 'Website chat');
  if (contractorId) {
    sendContractorSms(contractorId, `LeadPro: New lead — ${lead.name || 'Unknown'}, ${lead.service || 'service inquiry'}. Phone ${lead.phone || ''}.`)
      .catch(e => console.error('[agent/send-confirmation] alert SMS error:', e.message));
  }

  res.json({ success: true });
}));

// POST /vapi-webhook — Vapi calls this at end of every phone call
router.post('/vapi-webhook', (req, res) => {
  // Acknowledge immediately — Vapi won't retry if we respond fast
  res.json({ received: true });

  const payload = req.body;
  const msg     = payload.message || payload;
  if ((msg.type || payload.type) !== 'end-of-call-report') return;

  const s    = msg.structuredData || {};
  const call = msg.call || {};
  const lead = {
    name:       s.name       || 'Unknown caller',
    phone:      s.phone      || call.customer?.number || '—',
    email:      s.email      || null,
    address:    s.address    || '—',
    service:    s.service    || '—',
    datetime:   s.datetime   || '—',
    transcript: msg.transcript || '',
  };

  // Fire-and-forget — we already responded 200
  (async () => {
    try {
      await saveLead(lead, 'phone');
      await email.sendLeadAlertWithTranscript(lead, 'Phone call', lead.transcript);
      await email.sendConfirmation(lead);
      console.log('[vapi-webhook] Phone lead processed:', lead.name);
    } catch (e) {
      console.error('[vapi-webhook] Error processing lead:', e.message);
    }
  })();
});

// ── AGENT SYSTEM PROMPT BUILDER ──────────────────────────────────────────────

function buildAgentSystemPrompt(c) {
  const ownerName   = (c.owner_name    || '').trim() || 'our team';
  const bizName     = (c.business_name || '').trim() || 'our company';
  const trade       = (c.trade         || '').trim() || 'home services';
  const serviceArea = (c.service_area  || '').trim() || 'your area';
  const hours       = (c.hours         || '').trim() || 'Monday–Friday 7am–6pm';
  const services    = (c.services      || '').trim() || 'general home services';
  const bookingLink = (c.booking_link  || '').trim() || 'we will call you back shortly';

  return `You are ${ownerName}'s virtual assistant at ${bizName}, a ${trade} company serving ${serviceArea}.

Your job is to respond to missed calls via text message. You are warm, local, and efficient — like a trusted office manager, not a call center robot.

BUSINESS HOURS: ${hours}
SERVICES: ${services}
BOOKING LINK: ${bookingLink}

YOUR GOALS (in order):
1. Acknowledge the missed call immediately and apologize
2. Find out what they need help with
3. Capture: name, address, best callback number if different
4. Offer the booking link OR tell them someone will call back within 2 hours
5. Confirm everything and close warmly

RULES YOU NEVER BREAK:
- Never quote a price. Say "we'd be happy to give you a free estimate."
- Never make up availability. Say "let me have ${ownerName} confirm that with you."
- If they ask "is this a bot?" say "I'm ${bizName}'s automated assistant — a real person will follow up shortly."
- Keep every reply under 3 sentences.
- Ask only one question per message.
- If it's an emergency (no heat, flooding, gas smell) say: "This sounds urgent — I'm flagging this for immediate callback. What's the best number to reach you?"
- Never discuss competitors.
- If they're angry or frustrated, acknowledge first: "I completely understand — let me make sure someone gets back to you right away."

CONVERSATION FLOW:
Opening (always start with this):
"Hi! Sorry we missed your call — this is ${bizName}'s messaging assistant. [Owner] is on a job right now. What can we help you with today?"

After collecting their need → offer booking link:
"Great — you can grab a time that works for you here: ${bookingLink} Or I can have someone call you back within 2 hours. Which works better?"

Closing (after info collected):
"Perfect — I've got everything. Expect a call from ${ownerName} shortly. Is there anything else before I let you go?"`;
}

// POST /api/agent-config — return the fully built system prompt for a contractor
router.post('/api/agent-config', catchAsync(async (req, res) => {
  const { contractorId } = req.body;
  if (!contractorId) return res.status(400).json({ error: 'contractorId required' });

  const { data, error } = await supabase
    .from('contractors')
    .select('business_name, owner_name, trade, service_area, hours, services, booking_link')
    .eq('id', contractorId)
    .single();

  if (!data) return res.status(404).json({ error: 'Contractor not found' });

  res.json({ systemPrompt: buildAgentSystemPrompt(data) });
}));

// POST /api/test-agent — run a conversation turn through the agent system prompt
router.post('/api/test-agent', catchAsync(async (req, res) => {
  const { contractorId, messages } = req.body;
  if (!contractorId || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'contractorId and messages array required' });
  }

  const { data, error } = await supabase
    .from('contractors')
    .select('business_name, owner_name, trade, service_area, hours, services, booking_link')
    .eq('id', contractorId)
    .single();

  if (!data) return res.status(404).json({ error: 'Contractor not found' });

  const payload = JSON.stringify({
    model:      CLAUDE_MODEL,
    max_tokens: 300,
    system:     buildAgentSystemPrompt(data),
    messages,
  });
  proxyToAnthropic(payload, res);
}));

// POST /send-roi-email — send weekly ROI summary email to a contractor
router.post('/send-roi-email', catchAsync(async (req, res) => {
  const { contractorId } = req.body;
  if (!contractorId) return res.status(400).json({ error: 'contractorId required' });

  // ── Week boundaries (UTC) ──────────────────────────────────────────────────
  const now          = new Date();
  const dayOfWeek    = now.getUTCDay();                            // 0=Sun … 6=Sat
  const daysFromMon  = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisMonday = new Date(now);
  thisMonday.setUTCDate(thisMonday.getUTCDate() - daysFromMon);
  thisMonday.setUTCHours(0, 0, 0, 0);

  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);

  // ── Supabase queries (parallel) ────────────────────────────────────────────
  const [thisWeekRes, lastWeekRes, authRes, contractorRes] = await Promise.all([
    supabase
      .from('leads')
      .select('name, service, requested_at')
      .eq('contractor_id', contractorId)
      .gte('requested_at', thisMonday.toISOString())
      .order('requested_at', { ascending: false }),

    supabase
      .from('leads')
      .select('id')
      .eq('contractor_id', contractorId)
      .gte('requested_at', lastMonday.toISOString())
      .lt('requested_at', thisMonday.toISOString()),

    supabase.auth.admin.getUserById(contractorId),

    supabase
      .from('contractors')
      .select('business_name')
      .eq('id', contractorId)
      .single(),
  ]);

  if (thisWeekRes.error) return res.status(500).json({ error: thisWeekRes.error.message });
  if (lastWeekRes.error) return res.status(500).json({ error: lastWeekRes.error.message });
  if (authRes.error || !authRes.data?.user) return res.status(404).json({ error: 'Contractor not found' });

  const contractorEmail = authRes.data.user.email;
  const bizName         = contractorRes.data?.business_name || 'Your Business';

  // ── Calculations ───────────────────────────────────────────────────────────
  const leadsThisWeek  = thisWeekRes.data.length;
  const leadsLastWeek  = lastWeekRes.data.length;
  const percentChange  = leadsLastWeek === 0
    ? 'first week'
    : Math.round((leadsThisWeek - leadsLastWeek) / leadsLastWeek * 100);
  const estimatedValue = leadsThisWeek * 450;
  const roiMultiple    = Math.floor(estimatedValue / 97);

  // ── Top 3 leads with human-readable time ──────────────────────────────────
  function timeAgo(dateStr) {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins   = Math.floor(diffMs / 60_000);
    const hrs    = Math.floor(mins / 60);
    const days   = Math.floor(hrs  / 24);
    if (days >= 1) return `${days} day${days  > 1 ? 's' : ''} ago`;
    if (hrs  >= 1) return `${hrs} hour${hrs   > 1 ? 's' : ''} ago`;
    return `${Math.max(1, mins)} min${mins > 1 ? 's' : ''} ago`;
  }

  const topLeads = thisWeekRes.data.slice(0, 3).map(l => ({
    name:    l.name,
    service: l.service,
    timeAgo: timeAgo(l.requested_at),
  }));

  // ── Send ───────────────────────────────────────────────────────────────────
  await email.sendROIEmail(contractorEmail, {
    leadsThisWeek,
    leadsLastWeek,
    percentChange,
    estimatedValue,
    roiMultiple,
    topLeads,
    bizName,
  });

  console.log(`[send-roi-email] Sent to ${contractorEmail} — ${leadsThisWeek} leads, ~$${estimatedValue}`);
  res.json({ success: true, leadsThisWeek, estimatedValue, sentTo: contractorEmail });
}));

// POST /api/generate-pitch — AI-personalized cold-call opener for a prospector lead
router.post('/api/generate-pitch', catchAsync(async (req, res) => {
  const { name, phone, website, score, missing, address } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // Extract city from address (first comma-delimited segment after street)
  const city = (() => {
    if (!address) return 'their area';
    const parts = address.split(',').map(s => s.trim());
    // "123 Main St, Richmond, VA 12345" → parts[1] = "Richmond"
    return parts.length >= 2 ? parts[1] : parts[0];
  })();

  const missingStr = Array.isArray(missing) && missing.length
    ? missing.join(', ')
    : 'no major gaps identified';

  const prompt = `Write a 3-sentence cold call opener for a contractor software sales rep calling ${name} in ${city}.

Their gaps: ${missingStr}
Their website: ${website || 'none found'}
Lead score: ${score || 0}/100

Rules:
- Sentence 1: Identify yourself and the business by name
- Sentence 2: Reference ONE specific gap you found on their site
- Sentence 3: Ask for 2 minutes to show them how it works
- Sound like a real person, not a script
- Never mention AI — say 'automated text-back system'
- Keep total length under 40 words`;

  const payload = JSON.stringify({
    model:      CLAUDE_MODEL,
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
  });

  // Use proxyToAnthropic internally — build a small promise wrapper
  const pitch = await new Promise((resolve, reject) => {
    const { https: _https } = { https: require('https') };
    const apiReq = _https.request({
      hostname: 'api.anthropic.com',
      port:     443,
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(payload),
        'x-api-key':         cfg.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
    }, apiRes => {
      let d = '';
      apiRes.on('data', c => d += c);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const text = (parsed.content || []).map(c => c.text || '').join('').trim();
          resolve(text || 'No pitch generated.');
        } catch(e) {
          reject(new Error('Claude response parse error'));
        }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });

  res.json({ pitch });
}));

module.exports = router;
