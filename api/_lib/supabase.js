// api/_lib/supabase.js
//
// Per-tenant Supabase client factory.
//
// Current pattern (stage-aware per feedback_isolated_tenant_supabase_from_day_one):
//   - Multiple tenants may share a single Supabase PROJECT (cheap during
//     pre-revenue launch ramp), but each tenant has its own Postgres
//     SCHEMA inside that project. The schema name is declared in
//     config/tenants.js as `tenant.schema`.
//   - Once any tenant on a shared project hits 20 bookings/month, that
//     tenant gets split to its own Supabase project. At that point we
//     just point that tenant's env vars at the new project — no code
//     change here required.
//   - Tenant env vars (e.g. BANDAMA_SUPABASE_URL) can point at the same
//     project for tenants that currently share. When a tenant splits,
//     just update its own env vars to the new project — other tenants
//     unaffected.
//
// We use the SERVICE ROLE key on the server side — RLS is enabled on all
// tables and the anon key has zero access. The service role key MUST NEVER
// be exposed to the client.

const { createClient } = require('@supabase/supabase-js');
const { getTenantEnv } = require('./tenant.js');
const { getTenant } = require('../../config/tenants.js');

// Cache clients by tenant to avoid re-instantiating on every request.
// Two tenants sharing one Supabase project still get DIFFERENT cache
// entries — schema is part of the client config, so they need separate
// client instances to query the right schema.
const clientCache = new Map();

function getSupabase(tenantSlug) {
  if (clientCache.has(tenantSlug)) {
    return clientCache.get(tenantSlug);
  }

  const url = getTenantEnv(tenantSlug, 'SUPABASE_URL');
  const key = getTenantEnv(tenantSlug, 'SUPABASE_SERVICE_ROLE_KEY');

  // Resolve the Postgres schema for this tenant. Defaults to 'public' so
  // existing tenants without an explicit schema field keep working.
  const tenantConfig = getTenant(tenantSlug);
  const schema = tenantConfig.schema || 'public';

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema },
  });

  clientCache.set(tenantSlug, client);
  return client;
}

module.exports = { getSupabase };
