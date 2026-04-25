// scripts/test-signup.js
// Smoke-tests the full signup flow using auth.admin (creates auth.identities properly).
// Run with your real service key:
//   SUPABASE_SERVICE_KEY=eyJ... node scripts/test-signup.js
//
// Or locally if .env has the real key:
//   node scripts/test-signup.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key || key === 'your_key') {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY before running');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  const testEmail = `smoke-test-${Date.now()}@leadpro.dev`;
  let userId;

  try {
    // ── Step 1: auth.admin.createUser (also creates auth.identities) ──
    console.log('\n[test] step 1 — auth.admin.createUser:', testEmail);
    const { data: authData, error: createErr } = await supabase.auth.admin.createUser({
      email:         testEmail,
      password:      'TestPass123!',
      email_confirm: true,
    });

    if (createErr) {
      console.error('[test] step 1 FAILED:', createErr.message, { status: createErr.status });
      return;
    }

    userId = authData?.user?.id;
    if (!userId) {
      console.error('[test] step 1 FAILED: no user.id in response:', JSON.stringify(authData));
      return;
    }
    console.log('[test] step 1 OK — userId:', userId);

    // Verify auth.identities was created
    const { data: identities } = await supabase
      .from('auth.identities')
      .select('id')
      .eq('user_id', userId);
    console.log('[test] auth.identities rows for this user:', identities?.length ?? 'N/A (use SQL to verify)');

    // ── Step 2: contractors.insert (mirrors routes/auth.js exactly) ──
    const payload = {
      id:            userId,
      email:         testEmail,
      business_name: 'Smoke Test Co',
      plan:          'free',
      plan_status:   'trial',
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      widget_id:     'lp_smoketest',
    };
    console.log('[test] step 2 — contractors.insert:', payload);
    const { error: insertErr } = await supabase.from('contractors').insert(payload);

    if (insertErr) {
      console.error('[test] step 2 FAILED:', JSON.stringify({
        message: insertErr.message,
        code:    insertErr.code,
        details: insertErr.details,
        hint:    insertErr.hint,
      }));
    } else {
      console.log('[test] step 2 OK — contractor row inserted');

      // ── Step 3: signInWithPassword ──
      console.log('[test] step 3 — signInWithPassword');
      const { data: { session }, error: sessionErr } = await supabase.auth.signInWithPassword({
        email: testEmail, password: 'TestPass123!',
      });
      if (sessionErr || !session) {
        console.error('[test] step 3 FAILED:', sessionErr?.message);
      } else {
        console.log('[test] step 3 OK — session issued, expires_at:', session.expires_at);
        console.log('\n✅  Full signup flow passed');
      }
    }

  } finally {
    // Always clean up test user (cascades to contractors via FK)
    if (userId) {
      console.log('\n[test] cleanup — deleteUser', userId);
      const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
      if (delErr) console.error('[test] cleanup failed:', delErr.message);
      else console.log('[test] cleanup OK');
    }
  }
})();
