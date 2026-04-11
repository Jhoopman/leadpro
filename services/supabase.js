// services/supabase.js
// Shared Supabase admin client (service key — bypasses RLS).
// Never expose this to the browser.

const { createClient } = require('@supabase/supabase-js');
const cfg = require('../config');

const supabase = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey);

module.exports = supabase;
