// routes/prospector.js
// Searches Google Places for contractors by trade + location,
// scrapes their websites, and scores them as LeadPro prospects.

const express  = require('express');
const router   = express.Router();
const https    = require('https');
const scraper  = require('../services/scraper');
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

// POST /api/prospector
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

  const places  = (searchRes.results || []).slice(0, 10);
  const results = [];

  for (const place of places) {
    let name    = place.name;
    let phone   = null;
    let website = null;
    let address = place.formatted_address || '';

    try {
      const detail = await googlePlacesRequest(
        `details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address&key=${cfg.google.placesApiKey}`
      );
      const d = detail.result || {};
      name    = d.name                  || name;
      phone   = d.formatted_phone_number || null;
      website = d.website                || null;
      address = d.formatted_address      || address;
    } catch (e) {
      console.log('[prospector] Places detail error:', place.place_id, e.message);
    }

    const analysis = {
      hasWebsite:        !!website,
      hasChatWidget:     false,
      hasPhone:          !!phone,
      websiteQualityScore: 0,
      hasSSL:            false,
      hasMobileViewport: false,
    };

    if (website) {
      try {
        const siteUrl           = website.startsWith('http') ? website : 'https://' + website;
        const { html, finalUrl } = await scraper.fetchPageHTML(siteUrl);
        analysis.hasChatWidget     = scraper.checkChatWidget(html);
        if (!analysis.hasPhone) analysis.hasPhone = scraper.checkPhoneNumber(html);
        const quality              = scraper.checkWebsiteQuality(html, finalUrl);
        analysis.websiteQualityScore = quality.score;
        analysis.hasSSL            = quality.hasSSL;
        analysis.hasMobileViewport = quality.hasMobileViewport;
      } catch (e) {
        console.log('[prospector] Website fetch error:', website, e.message);
      }
    }

    const { score, missing } = scraper.scoreContractor(analysis);
    results.push({ name, phone, website, address, score, missing, ...analysis });
  }

  results.sort((a, b) => b.score - a.score);
  console.log(`[prospector] Found ${results.length} results for "${industry}" in "${location}"`);
  res.json({ results });
}));

module.exports = router;
