// scripts/create-internal-account.js
// INTERNAL ACCOUNT — skip billing
// One-time script. Run once from project root:
//   node scripts/create-internal-account.js
//
// Creates the josiah@useleadpro.net internal account via the Auth Admin API
// (not raw SQL) and upserts its contractors row with is_internal: true.
// Password is NOT set here — go to Supabase Dashboard > Auth > Users,
// find josiah@useleadpro.net, and use "Send password reset" to set it.

'use strict';

require('dotenv').config();
const supabase = require('../services/supabase');

const INTERNAL_EMAIL = 'josiah@useleadpro.net';

async function run() {
  console.log('[create-internal-account] starting');

  // ── Step 1: Create auth user (Admin API — not raw SQL) ────────────────────
  console.log('[create-internal-account] creating auth user:', INTERNAL_EMAIL);
  const { data: authData, error: createErr } = await supabase.auth.admin.createUser({
    email:         INTERNAL_EMAIL,
    email_confirm: true, // INTERNAL ACCOUNT — skip billing — no email verification needed
  });

  let userId;

  if (createErr) {
    // If already exists, look up the existing user instead of failing
    if (
      createErr.message.includes('already registered') ||
      createErr.message.includes('already exists') ||
      createErr.message.includes('duplicate')
    ) {
      console.log('[create-internal-account] auth user already exists — looking up id');
      const { data: listData, error: listErr } = await supabase.auth.admin.listUsers();
      if (listErr) { console.error('listUsers failed:', listErr.message); process.exit(1); }
      const existing = listData.users.find(u => u.email === INTERNAL_EMAIL);
      if (!existing) { console.error('Could not find existing user'); process.exit(1); }
      userId = existing.id;
      console.log('[create-internal-account] found existing auth user:', userId);
    } else {
      console.error('[create-internal-account] createUser failed:', createErr.message);
      process.exit(1);
    }
  } else {
    userId = authData.user.id;
    console.log('[create-internal-account] auth user created:', userId);
  }

  // ── Step 2: Upsert contractors row ────────────────────────────────────────
  // INTERNAL ACCOUNT — skip billing — is_internal: true, no Stripe, no trial
  const payload = {
    id:                 userId,
    email:              INTERNAL_EMAIL,
    business_name:      'LeadPro Internal',
    plan:               'pro',
    plan_status:        'active',
    trial_ends_at:      null,
    stripe_customer_id: 'internal_no_billing', // INTERNAL ACCOUNT — skip billing
    is_internal:        true,                  // INTERNAL ACCOUNT — skip billing
    created_at:         new Date().toISOString(),
  };

  console.log('[create-internal-account] upserting contractors row:', payload);

  const { error: upsertErr } = await supabase
    .from('contractors')
    .upsert(payload, { onConflict: 'id' });

  if (upsertErr) {
    console.error('[create-internal-account] upsert failed:', upsertErr.message);
    process.exit(1);
  }

  console.log('[create-internal-account] done');
  console.log('');
  console.log('  ✅  Auth user created / confirmed: ' + INTERNAL_EMAIL);
  console.log('  ✅  contractors row: plan=pro, status=active, is_internal=true');
  console.log('  ✅  stripe_customer_id: internal_no_billing');
  console.log('');
  console.log('  Next: Supabase Dashboard → Auth → Users → josiah@useleadpro.net');
  console.log('        Click "Send password reset email" — or set it directly in the dashboard.');
  process.exit(0);
}

run().catch(e => {
  console.error('[create-internal-account] unexpected error:', e.message);
  process.exit(1);
});
