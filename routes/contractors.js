// routes/contractors.js
// Contractor profile lookup (used by widget) and account provisioning.

const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { catchAsync } = require('../middleware/errorHandler');

// GET /contractor/:id — widget fetches contractor profile by widget_id
router.get('/contractor/:id', catchAsync(async (req, res) => {
  const { data, error } = await supabase
    .from('contractors')
    .select('id, business_name, services, google_connected')
    .eq('widget_id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Contractor not found' });
  res.json(data);
}));

// POST /ensure-contractor — creates contractor row via service key if it doesn't exist.
// Called from frontend after signup (RLS blocks anon insert while email confirmation is pending).
router.post('/ensure-contractor', catchAsync(async (req, res) => {
  const { userId, businessName } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const { data: existing } = await supabase
    .from('contractors')
    .select('id')
    .eq('id', userId)
    .limit(1);

  if (existing?.[0]) return res.json({ created: false });

  const widgetId  = 'lp_' + Math.random().toString(36).substr(2, 8);
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 14);

  const { error } = await supabase.from('contractors').insert({
    id:           userId,
    business_name: businessName || '',
    widget_id:    widgetId,
    plan:         'free',
    plan_status:  'trial',
    trial_ends_at: trialEnds.toISOString(),
  });

  if (error) throw new Error(error.message);
  res.json({ created: true, widgetId });
}));

module.exports = router;
