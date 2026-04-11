// routes/prospector.js
// Searches Google Places for contractors by trade + location,
// scrapes their websites in parallel, and scores them as LeadPro prospects.
// Also provides campaign CRUD for saving / tracking leads.
//
// Supabase tables required (run once in your Supabase SQL editor):
//
//   create table prospector_campaigns (
//     id            uuid primary key default gen_random_uuid(),
//     contractor_id uuid not null,
//     name          text not null,
//     created_at    timestamptz default now()
//   );
//
//   create table prospector_leads (
//     id                uuid primary key default gen_random_uuid(),
//     campaign_id       uuid references prospector_campaigns(id) on delete cascade,
//     business_name     text,
//     phone             text,
//     website           text,
//     address           text,
//     score             int default 0,
//     missing           text,   -- JSON-stringified array
//     status            text default 'Not contacted',
//     notes             text default '',
//     last_contacted_at timestamptz,
//     created_at        timestamptz default now()
//   );

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const scraper  = require('../services/scraper');
const supabase = require('../services/supabase');
const { catchAsync }        = require('../middleware/errorHandler');
const { prospectorLimit }   = require('../middleware/rateLimit');
const cfg      = require('../config');

function googlePlacesRequest(apiPath) {
  return new Promise((resolve, reject) => {
    https.get('https://maps.googleapis.com/maps/api/place/' + apiPath, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try   { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Places API parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

// ── POST /api/prospector ──────────────────────────────────────────────────────
// All 10 places are scraped in parallel via Promise.allSettled().
// Each place: details fetch → website scrape → score. Failed scrapes
// return a partial result (basic info, score from what was found).
router.post('/api/prospector', prospectorLimit, catchAsync(async (req, res) => {
  if (!cfg.google.placesApiKey) {
    return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured' });
  }

  const { location, industry } = req.body;
  if (!location || !industry) return res.status(400).json({ error: 'Missing location or industry' });

  const query     = encodeURIComponent(`${industry} contractors in ${location}`);
  const searchRes = await googlePlacesRequest(
    `textsearch/json?query=${query}&type=establishment&key=${cfg.google.placesApiKey}`
  );

  if (searchRes.status !== 'OK' && searchRes.status !== 'ZERO_RESULTS') {
    return res.status(500).json({ error: 'Places API: ' + searchRes.status, details: searchRes.error_message });
  }

  const places = (searchRes.results || []).slice(0, 10);

  // Run all places in parallel — each resolves to a result object
  const settled = await Promise.allSettled(places.map(async place => {
    let name    = place.name;
    let phone   = null;
    let website = null;
    let address = place.formatted_address || '';
    let rating  = place.rating || null;

    try {
      const detail = await googlePlacesRequest(
        `details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address&key=${cfg.google.placesApiKey}`
      );
      const d = detail.result || {};
      name    = d.name                   || name;
      phone   = d.formatted_phone_number || null;
      website = d.website                || null;
      address = d.formatted_address      || address;
    } catch (e) {
      console.log('[prospector] Places detail error:', place.place_id, e.message);
    }

    const analysis = {
      hasWebsite:          !!website,
      hasChatWidget:       false,
      hasPhone:            !!phone,
      websiteQualityScore: 0,
      hasSSL:              false,
      hasMobileViewport:   false,
      rating,
    };

    if (website) {
      try {
        const siteUrl            = website.startsWith('http') ? website : 'https://' + website;
        const { html, finalUrl } = await scraper.fetchPageHTML(siteUrl);
        analysis.hasChatWidget     = scraper.checkChatWidget(html);
        if (!analysis.hasPhone) analysis.hasPhone = scraper.checkPhoneNumber(html);
        const quality              = scraper.checkWebsiteQuality(html, finalUrl);
        analysis.websiteQualityScore = quality.score;
        analysis.hasSSL              = quality.hasSSL;
        analysis.hasMobileViewport   = quality.hasMobileViewport;
      } catch (e) {
        console.log('[prospector] Website fetch error:', website, e.message);
      }
    }

    const { score, missing } = scraper.scoreContractor(analysis);
    return { name, phone, website, address, score, missing, ...analysis };
  }));

  // Include fulfilled results; rejected ones are silently dropped
  const results = settled
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  results.sort((a, b) => b.score - a.score);
  console.log(`[prospector] Found ${results.length} results for "${industry}" in "${location}"`);
  res.json({ results });
}));

// ── CAMPAIGN ROUTES ───────────────────────────────────────────────────────────

// GET /api/campaigns?contractor_id=...
router.get('/api/campaigns', catchAsync(async (req, res) => {
  const { contractor_id } = req.query;
  if (!contractor_id) return res.status(400).json({ error: 'contractor_id required' });

  const { data, error } = await supabase
    .from('prospector_campaigns')
    .select('id, name, created_at')
    .eq('contractor_id', contractor_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Attach lead counts
  const ids = (data || []).map(c => c.id);
  let counts = {};
  if (ids.length) {
    const { data: leads } = await supabase
      .from('prospector_leads')
      .select('campaign_id, status')
      .in('campaign_id', ids);
    (leads || []).forEach(l => {
      if (!counts[l.campaign_id]) counts[l.campaign_id] = { total: 0, won: 0 };
      counts[l.campaign_id].total++;
      if (l.status === 'Won') counts[l.campaign_id].won++;
    });
  }

  const campaigns = (data || []).map(c => ({
    ...c,
    lead_count: counts[c.id]?.total || 0,
    won_count:  counts[c.id]?.won   || 0,
  }));

  res.json({ campaigns });
}));

// POST /api/campaigns
router.post('/api/campaigns', catchAsync(async (req, res) => {
  const { contractor_id, name } = req.body;
  if (!contractor_id || !name) return res.status(400).json({ error: 'contractor_id and name required' });

  const { data, error } = await supabase
    .from('prospector_campaigns')
    .insert({ contractor_id, name })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ campaign: { ...data, lead_count: 0, won_count: 0 } });
}));

// DELETE /api/campaigns/:id  (cascades to leads via FK)
router.delete('/api/campaigns/:id', catchAsync(async (req, res) => {
  await supabase.from('prospector_leads').delete().eq('campaign_id', req.params.id);
  const { error } = await supabase.from('prospector_campaigns').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

// GET /api/campaigns/:id/leads
router.get('/api/campaigns/:id/leads', catchAsync(async (req, res) => {
  const { data, error } = await supabase
    .from('prospector_leads')
    .select('*')
    .eq('campaign_id', req.params.id)
    .order('score', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ leads: data || [] });
}));

// POST /api/campaigns/:id/leads
router.post('/api/campaigns/:id/leads', catchAsync(async (req, res) => {
  const { business_name, phone, website, address, score, missing } = req.body;

  const { data, error } = await supabase
    .from('prospector_leads')
    .insert({
      campaign_id:   req.params.id,
      business_name: business_name || '',
      phone:         phone         || '',
      website:       website       || '',
      address:       address       || '',
      score:         score         || 0,
      missing:       JSON.stringify(missing || []),
      status:        'Not contacted',
      notes:         '',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ lead: data });
}));

// PATCH /api/campaigns/leads/:leadId  — update status and/or notes
router.patch('/api/campaigns/leads/:leadId', catchAsync(async (req, res) => {
  const { status, notes } = req.body;
  const updates = {};

  if (status !== undefined) {
    updates.status = status;
    if (status !== 'Not contacted') {
      updates.last_contacted_at = new Date().toISOString();
    }
  }
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase
    .from('prospector_leads')
    .update(updates)
    .eq('id', req.params.leadId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ lead: data });
}));

// DELETE /api/campaigns/leads/:leadId
router.delete('/api/campaigns/leads/:leadId', catchAsync(async (req, res) => {
  const { error } = await supabase
    .from('prospector_leads')
    .delete()
    .eq('id', req.params.leadId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

module.exports = router;
