// services/supabase.js
// Shared Supabase admin client (service key — bypasses RLS).
// Never expose this to the browser.
//
// persistSession + autoRefreshToken must be false on a server-side service-role
// client. Without them, any signInWithPassword() call stores a user JWT on this
// singleton; subsequent from() calls then send that user JWT instead of the
// service key, making PostgREST apply RLS and reject inserts for other users.

const { createClient } = require('@supabase/supabase-js');
const cfg = require('../config');

const supabase = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

module.exports = supabase;
