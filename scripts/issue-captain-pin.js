#!/usr/bin/env node
//
// scripts/issue-captain-pin.js — issue a starter PIN for an operator.
//
// Generates a random 6-digit PIN, stores ONLY its hash in the tenant's
// captain_pins table (must_change=true), and prints the PIN once so you can
// hand it to the operator. They are forced to set their own PIN on first sign-in.
//
// Run locally from the repo root with the tenant's env vars available
// (the same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the app uses):
//
//   TENANT_SLUG=bandama node scripts/issue-captain-pin.js info@bandamacharters.com
//
// Re-running for the same email re-issues a fresh starter PIN (must_change=true).

const { getSupabase } = require('../api/_lib/supabase.js');
const { hashPin, generatePin } = require('../api/_lib/captain-auth.js');

(async () => {
  const tenant = (process.env.TENANT_SLUG || '').trim();
  const email = (process.argv[2] || '').trim().toLowerCase();

  if (!tenant || !email) {
    console.error('Usage: TENANT_SLUG=<slug> node scripts/issue-captain-pin.js <operator-email>');
    process.exit(1);
  }

  const pin = generatePin(6);
  const { hash, salt } = hashPin(pin);

  let supa;
  try { supa = getSupabase(tenant); }
  catch (e) {
    console.error('Could not connect to the tenant database. Check the tenant env vars are set.');
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  }

  const { error } = await supa.from('captain_pins').upsert({
    email,
    pin_hash: hash,
    pin_salt: salt,
    must_change: true,
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'email' });

  if (error) {
    console.error('Failed to write captain_pins row:', error.message || error);
    console.error('Has the captain_pins migration been applied to this tenant\'s schema?');
    process.exit(1);
  }

  console.log('');
  console.log(`  ✅ Starter PIN issued — ${tenant} — ${email}`);
  console.log(`     PIN: ${pin}`);
  console.log('     Share it with the operator. They must set their own PIN on first sign-in.');
  console.log('');
})();
