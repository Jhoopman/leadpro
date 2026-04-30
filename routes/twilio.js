// routes/twilio.js
// Twilio webhook handlers for LeadPro voice + SMS.
//
//   POST /twilio/voice        — incoming call: greet + forward, fall back to voicemail
//   POST /twilio/voice/status — Record action callback: persist call record
//   POST /twilio/sms          — incoming SMS: AI lead-capture conversation
//   POST /twilio/sms/status   — SMS delivery status callback
//
// Env vars required:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE (+13026647594)
//   TWILIO_FORWARD_PHONE — contractor's real mobile (optional; enables call forwarding)
//
// DB tables expected (non-fatal if missing):
//   contractors.twilio_phone  — maps Twilio "To" number → contractor row
//   contractors.forward_phone — destination for call forwarding
//   contractors.owner_email   — email for lead alerts
//   calls                     — persisted by voice/status
//   leads                     — persisted by sms

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const https    = require('https');
const supabase = require('../services/supabase');
const claude   = require('../services/claude');
const email    = require('../services/email');
const { catchAsync } = require('../middleware/errorHandler');
const cfg      = require('../config');

// Twilio posts application/x-www-form-urlencoded — parse it for these routes only
router.use(express.urlencoded({ extended: false }));

// ── TWILIO SIGNATURE VALIDATION ───────────────────────────────────────────────

function validateTwilio(req, res, next) {
  const authToken = cfg.twilio?.authToken;
  if (!authToken) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Twilio] BLOCKED — TWILIO_AUTH_TOKEN missing in production');
      return res.status(500).send('Server misconfigured');
    }
    console.warn('[Twilio] dev mode — skipping signature validation');
    return next();
  }

  const sig      = req.headers['x-twilio-signature'] || '';
  const url      = cfg.appUrl + req.originalUrl;
  const params   = req.body || {};
  const paramStr = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);

  const expected = crypto.createHmac('sha1', authToken).update(paramStr).digest('base64');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

async function contractorByPhone(toPhone) {
  if (!toPhone) return null;
  const { data } = await supabase
    .from('contractors')
    .select('id, business_name, forward_phone, owner_email, vapi_phone_number_id, vapi_assistant_id')
    .eq('twilio_phone', toPhone)
    .maybeSingle();
  return data || null;
}

// Send outbound SMS via Twilio REST (used for proactive messages; not needed for TwiML replies)
function sendSms(to, from, body) {
  const { accountSid, authToken } = cfg.twilio || {};
  if (!accountSid || !authToken) {
    console.warn('[Twilio] SMS not sent — missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
    return Promise.resolve();
  }
  const payload = new URLSearchParams({ To: to, From: from, Body: body }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── SMS CONVERSATION STATE ────────────────────────────────────────────────────
// In-memory map keyed by "fromPhone:contractorId".
// TODO: migrate to a sms_conversations Supabase table for multi-instance deploys.

const smsThreads = new Map();
const SMS_TTL_MS = 30 * 60 * 1000;

function getThread(key) {
  const t = smsThreads.get(key);
  if (!t || Date.now() - t.lastActive > SMS_TTL_MS) { smsThreads.delete(key); return null; }
  return t;
}
function setThread(key, t) { smsThreads.set(key, { ...t, lastActive: Date.now() }); }

function smsSystemPrompt(contractor) {
  const biz = contractor?.business_name || 'our team';
  return `You are an AI receptionist for ${biz}, a home service contractor. \
Collect lead info via SMS. Keep every reply under 160 characters. \
Gather: name, service needed, address, and preferred appointment time. \
Phone is already known from this SMS. \
Once you have name, service, and address, end your reply with a single line: \
LEAD:{"name":"","phone":"","service":"","address":"","datetime":"","notes":""} \
Fill in all fields you know. Before the LEAD line, always send a short friendly confirmation. \
Tone: warm, concise, professional. Plain text only.`;
}

function extractLead(text) {
  const m = text.match(/LEAD:(\{[^}]+\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── ROUTE 1: Incoming voice call ───────────────────────────────────────────────
// Connects to Vapi AI via SIP when vapi_phone_number_id is configured.
// Falls back to voicemail when Vapi is not yet set up for this contractor.

router.post('/twilio/voice', validateTwilio, catchAsync(async (req, res) => {
  const toPhone    = req.body.To || cfg.twilio?.phone || '';
  const fromPhone  = req.body.From || '';
  const contractor = await contractorByPhone(toPhone);
  const bizName    = xmlEscape(contractor?.business_name || 'our office');

  // Route to Vapi AI when a phone number ID is configured
  const vapiPhoneId = contractor?.vapi_phone_number_id;
  if (vapiPhoneId) {
    console.log(`[Vapi] inbound call from ${fromPhone} → SIP ${vapiPhoneId}@sip.vapi.ai`);
    // SIP URI routes the call to the Vapi assistant tied to this phone number.
    // Vapi identifies caller via call.customer.number in the end-of-call webhook.
    const xml = `<Dial><Sip>sip:${xmlEscape(vapiPhoneId)}@sip.vapi.ai</Sip></Dial>`;
    return res.set('Content-Type', 'text/xml').send(twiml(xml));
  }

  // Fallback: voicemail (no Vapi phone number configured yet)
  console.log(`[Twilio Voice] no Vapi phone ID for ${toPhone} — falling back to voicemail`);
  const xml =
    `<Say voice="Polly.Joanna">Thanks for calling ${bizName}. Please leave a message after the tone and we will get back to you soon.</Say>` +
    `<Record action="/twilio/voice/status" maxLength="120" transcribe="true" />`;
  res.set('Content-Type', 'text/xml').send(twiml(xml));
}));

// ── ROUTE 2: Voice / voicemail status callback ────────────────────────────────

router.post('/twilio/voice/status', validateTwilio, catchAsync(async (req, res) => {
  const { CallSid, CallStatus, From, To, RecordingUrl, TranscriptionText } = req.body;
  console.log(`[Twilio Voice] ${CallSid} — ${CallStatus} from ${From}`);

  const contractor = await contractorByPhone(To);
  if (contractor) {
    const { error } = await supabase.from('calls').insert({
      contractor_id: contractor.id,
      call_sid:      CallSid,
      status:        CallStatus,
      from_phone:    From,
      recording_url: RecordingUrl      || null,
      transcription: TranscriptionText || null,
      created_at:    new Date().toISOString(),
    });
    if (error) console.warn('[Twilio Voice] calls insert skipped:', error.message);
  }

  res.set('Content-Type', 'text/xml').send(twiml(''));
}));

// ── ROUTE 3: Incoming SMS — AI lead-capture conversation ──────────────────────

router.post('/twilio/sms', validateTwilio, catchAsync(async (req, res) => {
  const fromPhone = req.body.From || '';
  const toPhone   = req.body.To   || cfg.twilio?.phone || '';
  const inbound   = (req.body.Body || '').trim();

  // ── A2P keyword handling — runs BEFORE Claude ──
  const keyword    = inbound.toUpperCase();
  const STOP_WORDS  = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
  const START_WORDS = ['START', 'YES', 'UNSTOP'];
  const HELP_WORDS  = ['HELP', 'INFO'];

  if (STOP_WORDS.includes(keyword) || START_WORDS.includes(keyword) || HELP_WORDS.includes(keyword)) {
    let reply;
    if (STOP_WORDS.includes(keyword)) {
      await supabase.from('contractors')
        .update({ sms_opted_out: true, sms_opted_out_at: new Date().toISOString() })
        .eq('mobile_phone', fromPhone);
      console.log(`[Twilio SMS] opt-out from ${fromPhone}`);
      reply = "LeadPro: You're unsubscribed. No more messages will be sent. Reply START to resubscribe.";
    } else if (START_WORDS.includes(keyword)) {
      await supabase.from('contractors')
        .update({ sms_opted_out: false, sms_opted_out_at: null })
        .eq('mobile_phone', fromPhone);
      console.log(`[Twilio SMS] opt-in restored from ${fromPhone}`);
      reply = "LeadPro: You're resubscribed. Reply STOP anytime to opt out.";
    } else {
      reply = "LeadPro lead alerts. Email support@useleadpro.net for help. Reply STOP to opt out.";
    }
    return res.set('Content-Type', 'text/xml').send(twiml(`<Message>${xmlEscape(reply)}</Message>`));
  }

  const contractor   = await contractorByPhone(toPhone);
  const contractorId = contractor?.id || null;
  const threadKey    = `${fromPhone}:${contractorId || 'default'}`;

  const thread = getThread(threadKey) || { messages: [], leadSaved: false };
  thread.messages.push({ role: 'user', content: inbound });

  const aiResponse = await claude.chatText({
    system:     smsSystemPrompt(contractor),
    messages:   thread.messages,
    max_tokens: 300,
  });

  // Strip LEAD: JSON line before replying over SMS
  const replyText = xmlEscape(aiResponse.replace(/LEAD:\{[^}]+\}/, '').trim());

  // Persist lead when Claude signals it has enough data
  const lead = extractLead(aiResponse);
  if (lead && !thread.leadSaved) {
    lead.phone         = lead.phone || fromPhone;
    lead.contractor_id = contractorId;

    if (contractorId) {
      const notes = [lead.datetime, lead.notes].filter(Boolean).join(' | ');
      const { error } = await supabase.from('leads').insert({
        contractor_id: contractorId,
        name:    lead.name    || '',
        phone:   lead.phone   || '',
        service: lead.service || '',
        address: lead.address || '',
        notes:   notes        || '',
        source:  'sms',
      });
      if (error) console.error('[Twilio SMS] lead insert error:', error.message);
    }

    if (contractor?.owner_email) {
      email.sendLeadAlert({ ...lead }, 'SMS')
        .catch(e => console.error('[Twilio SMS] alert email error:', e.message));
    }
    if (contractorId) {
      sendContractorSms(contractorId, `LeadPro: New lead — ${lead.name || 'Unknown'}, ${lead.service || 'service inquiry'}. Phone ${lead.phone}.`)
        .catch(e => console.error('[Twilio SMS] alert SMS error:', e.message));
    }

    thread.leadSaved = true;
  }

  thread.messages.push({ role: 'assistant', content: aiResponse });
  setThread(threadKey, thread);

  res.set('Content-Type', 'text/xml').send(twiml(`<Message>${replyText}</Message>`));
}));

// ── ROUTE 4: SMS delivery status callback ─────────────────────────────────────

router.post('/twilio/sms/status', validateTwilio, (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body;
  if (ErrorCode) {
    console.error(`[Twilio SMS] delivery failed — ${MessageSid} to ${To}: error ${ErrorCode}`);
  } else {
    console.log(`[Twilio SMS] ${MessageSid} → ${To}: ${MessageStatus}`);
  }
  res.sendStatus(204);
});

// Send SMS to a contractor with consent + opt-out checks.
// Use this for ALL outbound SMS to contractors (not for TwiML replies to leads).
async function sendContractorSms(contractorId, message) {
  const { data: c } = await supabase
    .from('contractors')
    .select('mobile_phone, sms_consent_given, sms_opted_out, business_name')
    .eq('id', contractorId)
    .single();

  if (!c) {
    console.warn(`[Twilio SMS] sendContractorSms — contractor ${contractorId} not found`);
    return { sent: false, reason: 'no_contractor' };
  }
  if (!c.mobile_phone) {
    console.warn(`[Twilio SMS] sendContractorSms — no mobile_phone for ${contractorId}`);
    return { sent: false, reason: 'no_phone' };
  }
  if (!c.sms_consent_given) {
    console.warn(`[Twilio SMS] sendContractorSms — no consent for ${contractorId}`);
    return { sent: false, reason: 'no_consent' };
  }
  // opt-out checked after consent so a future re-opt-in can clear it independently
  if (c.sms_opted_out) {
    console.warn(`[Twilio SMS] sendContractorSms — opted out: ${contractorId}`);
    return { sent: false, reason: 'opted_out' };
  }

  let body = message;
  if (!/STOP/i.test(body)) body += ' Reply STOP to opt out.';
  if (body.length > 160) body = body.slice(0, 157) + '...';

  await sendSms(c.mobile_phone, cfg.twilio.phone, body);
  console.log(`[Twilio SMS] sent to ${contractorId} (${c.mobile_phone})`);
  return { sent: true };
}

module.exports = { router, sendSms, sendContractorSms };
