// api/_lib/tenant.js
//
// Resolves a tenant slug from request body/query, validates it against
// config/tenants.js, and exposes a `getTenantEnv(slug, key)` helper that
// reads tenant-namespaced env vars like BANDAMA_SUPABASE_URL.
//
// Rationale: multiple tenants share this Vercel project. Each tenant has
// its own Supabase project + own Stripe account. Namespacing env vars by
// tenant slug makes it impossible to cross the wires.

const { getTenant } = require('../../config/tenants.js');

function envKey(slug, key) {
  // bandama, supabase_url → BANDAMA_SUPABASE_URL
  return `${slug.toUpperCase().replace(/-/g, '_')}_${key.toUpperCase()}`;
}

function getTenantEnv(slug, key) {
  const k = envKey(slug, key);
  const v = process.env[k];
  if (!v) {
    throw new Error(`Missing required env var: ${k}`);
  }
  return v;
}

function getTenantEnvOptional(slug, key, fallback = null) {
  const k = envKey(slug, key);
  return process.env[k] ?? fallback;
}

function resolveTenant(req) {
  // Tenant can come from body (POST) or query (GET)
  const slug =
    (req.body && req.body.tenant) ||
    (req.query && req.query.tenant) ||
    null;
  if (!slug) {
    throw new Error('Missing tenant identifier');
  }
  const config = getTenant(slug);  // throws if unknown
  return { slug, config };
}

module.exports = {
  getTenantEnv,
  getTenantEnvOptional,
  resolveTenant,
  envKey,
};
