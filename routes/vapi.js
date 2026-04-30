// routes/vapi.js
// Vapi.ai voice agent integration for LeadPro.
//
//   POST /webhooks/vapi/end-of-call       — Vapi calls this when a call ends
//   POST /api/vapi/assistant              — Create / update a Vapi assistant for a contractor
//   GET  /api/vapi/test-call              — Trigger outbound test call via Vapi
//   GET  /api/vapi/calls                  — List recent Vapi calls with transcripts
//
// Env vars required:
//   VAPI_API_KEY             — already set in Render
//   VAPI_PHONE_NUMBER_ID     — optional; needed only for outbound test calls without a Vapi phone

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const supabase = require('../services/supabase');
const claude   = require('../services/claude');
const email    = require('../services/email');
const { sendContractorSms } = require('./twilio');
const { catchAsync } = require('../middleware/errorHandler');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_HOST    = 'api.vapi.ai';

// ── VAPI HTTP CLIENT ──────────────────────────────────────────────────────────

function vapiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: VAPI_HOST,
        port:     443,
        path,
        method,
        headers: {
          Authorization:  `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── LEAD EXTRACTION ───────────────────────────────────────────────────────────

async function extractLeadFromTranscript(transcript) {
  const prompt = `Extract lead information from this service call transcript.
Return ONLY valid JSON — no markdown, no explanation:
{"name":"","phone":"","service":"","address":"","datetime":"","notes":""}
Use null for fields not found. Infer service type from context.

Transcript:
${transcript.slice(0, 3000)}`;

  try {
    const text = await claude.chatText({
      model:    'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
    });
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return {};
  }
}

// ── ROUTE 1: Vapi end-of-call webhook ─────────────────────────────────────────
// Vapi posts here immediately after a call ends.
// Return 200 right away — heavy processing runs async so Vapi's timeout isn't hit.

router.post('/webhooks/vapi/end-of-call', (req, res) => {
  res.sendStatus(200);

  setImmediate(async () => {
    const msg = req.body?.message;
    if (!msg) return;

    const callId      = msg.call?.id          || '';
    const callerPhone = msg.call?.customer?.number || '';
    const assistantId = msg.call?.assistantId  || '';
    const phoneNumId  = msg.call?.phoneNumberId || '';
    const transcript  = msg.artifact?.transcript || msg.transcript || '';
    const startedAt   = msg.call?.startedAt;
    const endedAt     = msg.call?.endedAt;
    const durationSec = startedAt && endedAt
      ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000))
      : 0;

    console.log(`[Vapi] end-of-call ${callId} from ${callerPhone} (${durationSec}s)`);

    try {
      // Look up contractor by vapi_phone_number_id or vapi_assistant_id
      let contractor = null;
      if (phoneNumId) {
        const { data } = await supabase
          .from('contractors')
          .select('id, business_name, owner_email')
          .eq('vapi_phone_number_id', phoneNumId)
          .maybeSingle();
        contractor = data;
      }
      if (!contractor && assistantId) {
        const { data } = await supabase
          .from('contractors')
          .select('id, business_name, owner_email')
          .eq('vapi_assistant_id', assistantId)
          .maybeSingle();
        contractor = data;
      }

      const contractorId = contractor?.id || null;

      // Prefer Vapi's structured extraction; fall back to Claude
      let lead = {};
      const vapiStructured = msg.analysis?.structuredData;
      if (vapiStructured && (vapiStructured.name || vapiStructured.service)) {
        lead = vapiStructured;
      } else if (transcript.length > 20) {
        lead = await extractLeadFromTranscript(transcript);
      }

      lead.phone = lead.phone || callerPhone;

      // Build notes string (encodes fields the leads table doesn't have columns for)
      const notesParts = [
        lead.datetime ? `Requested: ${lead.datetime}` : '',
        lead.notes    ? lead.notes                   : '',
        `Source: Vapi voice call`,
        callId        ? `Call ID: ${callId}`         : '',
      ].filter(Boolean);

      // Persist lead
      if (contractorId && (lead.name || lead.service || callerPhone)) {
        const { error: leadErr } = await supabase.from('leads').insert({
          contractor_id: contractorId,
          name:          lead.name    || '',
          phone:         lead.phone   || callerPhone,
          service:       lead.service || '',
          address:       lead.address || '',
          notes:         notesParts.join(' | '),
        });
        if (leadErr) console.error('[Vapi] leads insert error:', leadErr.message);
        else          console.log(`[Vapi] lead saved for contractor ${contractorId}`);
      }

      // Persist call record
      if (contractorId) {
        const { error: callErr } = await supabase.from('calls').insert({
          contractor_id:    contractorId,
          caller_phone:     callerPhone,
          duration_seconds: durationSec,
          status:           lead.name || lead.service ? 'lead_captured' : 'answered',
          transcript:       transcript.slice(0, 10000),
          lead_data:        Object.keys(lead).length ? lead : null,
        });
        if (callErr) console.warn('[Vapi] calls insert skipped:', callErr.message);
      }

      // Email alert with transcript
      if (contractor?.owner_email && (lead.name || lead.service || callerPhone)) {
        email.sendLeadAlertWithTranscript(
          { ...lead, bizName: contractor.business_name },
          'Vapi Voice',
          transcript
        ).catch(e => console.error('[Vapi] alert email error:', e.message));
      }
      if (contractorId) {
        sendContractorSms(contractorId, `LeadPro: New lead — ${lead.name || 'Unknown'}, ${lead.service || 'service inquiry'}. Phone ${lead.phone || callerPhone}.`)
          .catch(e => console.error('[Vapi] alert SMS error:', e.message));
      }

    } catch (err) {
      console.error('[Vapi] end-of-call processing error:', err.message);
    }
  });
});

// ── ROUTE 2: Create / update Vapi assistant for a contractor ──────────────────

router.post('/api/vapi/assistant', catchAsync(async (req, res) => {
  const { contractor_id } = req.body;
  if (!contractor_id) return res.status(400).json({ error: 'contractor_id required' });

  const { data: contractor, error: dbErr } = await supabase
    .from('contractors')
    .select('id, business_name, services, profile, vapi_assistant_id')
    .eq('id', contractor_id)
    .maybeSingle();

  if (dbErr || !contractor) {
    return res.status(404).json({ error: 'Contractor not found' });
  }

  const profile     = contractor.profile   || {};
  const bizName     = contractor.business_name || 'our team';
  const ownerName   = profile.owner_name   || 'our owner';
  const services    = contractor.services  || profile.services  || 'home services';
  const serviceArea = profile.service_area || 'your local area';
  const hours       = profile.hours        || 'during business hours';
  const bookingUrl  = profile.booking_url  || '';
  const serviceList = Array.isArray(services) ? services.join(', ') : services;

  const systemPrompt =
    `You are ${bizName}'s friendly AI receptionist. Greet callers warmly and help them schedule a service appointment. ` +
    `Collect: full name, phone number, service address, type of service needed, and preferred appointment time. ` +
    `Services offered: ${serviceList}. Service area: ${serviceArea}. Hours: ${hours}. ` +
    `Always confirm details before ending the call. Never quote prices — say we provide free estimates. ` +
    `If unsure about anything, say ${ownerName} will follow up personally.` +
    (bookingUrl ? ` Online booking is also available at ${bookingUrl}.` : '') +
    ` Keep responses concise and conversational — you are on the phone, not chatting.`;

  const assistantPayload = {
    name:         `${bizName} Receptionist`,
    model: {
      provider:     'anthropic',
      model:        'claude-sonnet-4-20250514',
      systemPrompt,
    },
    voice: {
      provider: 'playht',
      voiceId:  'jennifer',
    },
    firstMessage:           `Thank you for calling ${bizName}! I'm your AI receptionist. How can I help you today?`,
    endCallFunctionEnabled: true,
    recordingEnabled:       true,
    transcriber: {
      provider: 'deepgram',
      model:    'nova-2',
      language: 'en-US',
    },
    // Vapi structured data extraction — maps call info to lead fields
    analysisPlan: {
      structuredDataSchema: {
        type: 'object',
        properties: {
          name:     { type: 'string', description: 'Full name of the caller' },
          phone:    { type: 'string', description: 'Phone number provided by caller' },
          service:  { type: 'string', description: 'Type of service requested' },
          address:  { type: 'string', description: 'Service address' },
          datetime: { type: 'string', description: 'Preferred appointment date and time' },
          notes:    { type: 'string', description: 'Any additional notes or requests' },
        },
      },
    },
  };

  try {
    let vapiRes;
    if (contractor.vapi_assistant_id) {
      vapiRes = await vapiRequest('PATCH', `/assistant/${contractor.vapi_assistant_id}`, assistantPayload);
    } else {
      vapiRes = await vapiRequest('POST', '/assistant', assistantPayload);
    }

    if (vapiRes.status >= 400) {
      console.error('[Vapi] assistant API error:', vapiRes.body);
      return res.status(502).json({ error: 'Vapi API error', details: vapiRes.body });
    }

    const assistantId = vapiRes.body.id;

    await supabase
      .from('contractors')
      .update({ vapi_assistant_id: assistantId })
      .eq('id', contractor_id);

    console.log(`[Vapi] assistant ${assistantId} saved for contractor ${contractor_id}`);
    return res.json({ assistantId, assistant: vapiRes.body });

  } catch (err) {
    console.error('[Vapi] create assistant error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}));

// ── ROUTE 3: Trigger outbound test call ───────────────────────────────────────

router.get('/api/vapi/test-call', catchAsync(async (req, res) => {
  const { phone_number } = req.query;
  if (!phone_number) {
    return res.status(400).json({ error: 'phone_number query param required (e.g. ?phone_number=+15551234567)' });
  }

  const { data: contractor } = await supabase
    .from('contractors')
    .select('vapi_assistant_id')
    .not('vapi_assistant_id', 'is', null)
    .neq('vapi_assistant_id', '')
    .limit(1)
    .maybeSingle();

  const assistantId = contractor?.vapi_assistant_id;
  if (!assistantId) {
    return res.status(400).json({
      error: 'No Vapi assistant configured. Call POST /api/vapi/assistant first.',
    });
  }

  const callPayload = {
    assistantId,
    customer: { number: phone_number },
  };
  if (process.env.VAPI_PHONE_NUMBER_ID) {
    callPayload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  }

  try {
    const vapiRes = await vapiRequest('POST', '/call/phone', callPayload);

    if (vapiRes.status >= 400) {
      console.error('[Vapi] test call API error:', vapiRes.body);
      return res.status(502).json({ error: 'Vapi API error', details: vapiRes.body });
    }

    console.log(`[Vapi] test call to ${phone_number} initiated: ${vapiRes.body.id}`);
    return res.json({ callId: vapiRes.body.id, status: vapiRes.body.status });

  } catch (err) {
    console.error('[Vapi] test call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}));

// ── ROUTE 4: List recent Vapi calls ──────────────────────────────────────────

router.get('/api/vapi/calls', catchAsync(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

  try {
    const vapiRes = await vapiRequest('GET', `/call?limit=${limit}`, null);

    if (vapiRes.status >= 400) {
      return res.status(502).json({ error: 'Vapi API error', details: vapiRes.body });
    }

    return res.json(vapiRes.body);

  } catch (err) {
    console.error('[Vapi] list calls error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}));

module.exports = router;
