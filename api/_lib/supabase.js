// api/_lib/supabase.js
//
// Per-tenant Supabase client factory. Each tenant has its own Supabase
// project, so we instantiate a client per request using tenant-namespaced
// env vars (BANDAMA_SUPABASE_URL, BANDAMA_SUPABASE_SERVICE_ROLE_KEY, etc.).
//
// We use the SERVICE ROLE key on the server side — RLS is enabled on all
// tables and the anon key has zero access. The service role key MUST NEVER
// be exposed to the client.

const { createClient } = require('@supabase/supabase-js');
const { getTenantEnv } = require('./tenant.js');

// Cache clients by tenant to avoid re-instantiating on every request
const clientCache = new Map();

function getSupabase(tenantSlug) {
  if (clientCache.has(tenantSlug)) {
    return clientCache.get(tenantSlug);
  }

  const url = getTenantEnv(tenantSlug, 'SUPABASE_URL');
  const key = getTenantEnv(tenantSlug, 'SUPABASE_SERVICE_ROLE_KEY');

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db:   { schema: 'public' },
  });

  clientCache.set(tenantSlug, client);
  return client;
}

module.exports = { getSupabase };
