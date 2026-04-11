// services/claude.js
// Thin wrapper around the Anthropic API.
// All raw https calls to api.anthropic.com go through here.

const https  = require('https');
const cfg    = require('../config');

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Send a messages request to the Anthropic API.
 * @param {object} opts
 * @param {string}   [opts.model]
 * @param {string}   [opts.system]
 * @param {object[]}  opts.messages
 * @param {number}   [opts.max_tokens]
 * @returns {Promise<object>} Raw Anthropic response object
 */
function chat({ model = DEFAULT_MODEL, system, messages, max_tokens = 500 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens,
      ...(system ? { system } : {}),
      messages,
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      port:     443,
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':       'application/json',
        'Content-Length':     Buffer.byteLength(payload),
        'x-api-key':          cfg.anthropicApiKey,
        'anthropic-version':  '2023-06-01',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { reject(new Error('Claude API parse error: ' + e.message)); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Convenience: returns the plain text of the first content block.
 */
async function chatText(opts) {
  const { body } = await chat(opts);
  return body?.content?.[0]?.text || '';
}

/**
 * Extract structured contractor data from a website's text content.
 * Used by the /scrape endpoint during onboarding.
 */
async function extractContractorProfile(pageText) {
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

  try {
    const text = await chatText({ messages: [{ role: 'user', content: prompt }], max_tokens: 600 });
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

module.exports = { chat, chatText, extractContractorProfile };
