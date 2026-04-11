// routes/calendar.js
// Google Calendar OAuth flow + availability query + appointment booking.

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const calendar = require('../services/calendar');
const { catchAsync } = require('../middleware/errorHandler');

// GET /auth/google?contractor_id=X — redirect to Google consent
router.get('/auth/google', (req, res) => {
  const { contractor_id } = req.query;
  if (!contractor_id) return res.status(400).send('Missing contractor_id');
  res.redirect(calendar.getAuthUrl(contractor_id));
});

// GET /auth/google/callback — Google posts code here
router.get('/auth/google/callback', catchAsync(async (req, res) => {
  const { code, state: contractorId } = req.query;
  if (!code || !contractorId) return res.status(400).send('Missing code or state');

  try {
    await calendar.exchangeCodeForTokens(code, contractorId);
    console.log('[Google] Calendar connected for contractor:', contractorId);
    res.redirect('/?google_connected=true');
  } catch (e) {
    console.error('[Google] OAuth callback error:', e.message);
    res.redirect('/?google_error=true');
  }
}));

// GET /auth/google/status?contractor_id=X
router.get('/auth/google/status', catchAsync(async (req, res) => {
  const { contractor_id } = req.query;
  if (!contractor_id) return res.status(400).json({ error: 'Missing contractor_id' });

  const { data } = await supabase
    .from('contractors')
    .select('google_connected, google_calendar_id')
    .eq('id', contractor_id)
    .single();

  res.json({
    connected:  data?.google_connected  || false,
    calendarId: data?.google_calendar_id || null,
  });
}));

// POST /auth/google/disconnect
router.post('/auth/google/disconnect', catchAsync(async (req, res) => {
  const { contractor_id } = req.body;
  if (!contractor_id) return res.status(400).json({ error: 'Missing contractor_id' });

  await supabase.from('contractors').update({
    google_access_token:  null,
    google_refresh_token: null,
    google_calendar_id:   null,
    google_connected:     false,
  }).eq('id', contractor_id);

  res.json({ success: true });
}));

// GET /api/availability?contractor_id=X&date=YYYY-MM-DD
router.get('/api/availability', catchAsync(async (req, res) => {
  const { contractor_id, date } = req.query;
  if (!contractor_id || !date) {
    return res.status(400).json({ error: 'contractor_id and date required' });
  }
  const result = await calendar.getAvailableSlots(contractor_id, date);
  res.json(result);
}));

// POST /api/book-appointment
router.post('/api/book-appointment', catchAsync(async (req, res) => {
  const { contractor_id, lead_name, lead_email, lead_phone, service, start, end, notes } = req.body;
  if (!contractor_id || !start || !end) {
    return res.status(400).json({ error: 'contractor_id, start, and end are required' });
  }

  const result = await calendar.bookAppointment({
    contractorId: contractor_id,
    leadName:     lead_name,
    leadEmail:    lead_email,
    leadPhone:    lead_phone,
    service,
    start,
    end,
    notes,
  });

  console.log(`[Google] Event created for contractor ${contractor_id}:`, result.eventId);
  res.json({ success: true, ...result });
}));

module.exports = router;
