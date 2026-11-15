// api/_lib/tenant.js
//
// Resolves a tenant slug from request body/query, validates it against
// api/_lib/tenants.config.js, and exposes a `getTenantEnv(slug, key)` helper that
// reads tenant-namespaced env vars like BANDAMA_SUPABASE_URL.
//
// Rationale: multiple tenants share this Vercel project. Each tenant has
// its own Supabase project + own Stripe account. Namespacing env vars by
// tenant slug makes it impossible to cross the wires.

const { getTenant } = require('./tenants.config.js');

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

// Base URL for links in emails and redirects.
// Real tenants: their PUBLIC_BASE_URL env var, else production. An env var
// that exists but is empty counts as unset, so a link is never relative.
// Test-only tenants exist only on previews, so their links must point back at
// the deployment that received the request (a production link would dead-end,
// because the tenant does not exist there). The request host is honoured only
// when it equals a host name Vercel itself set for this deployment
// (VERCEL_URL / VERCEL_BRANCH_URL) — never an arbitrary header value.
function getPublicBaseUrl(req, slug, config) {
  if (config && config.testOnly) {
    const h = (req && req.headers) || {};
    const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
    const own = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
      .filter(Boolean)
      .map((x) => String(x).trim().toLowerCase());
    if (host && own.includes(host)) return `https://${host}`;
    if (process.env.VERCEL_ENV === 'development' && /^localhost(:\d{1,5})?$/.test(host)) {
      return `http://${host}`;
    }
    if (own.length) return `https://${own[0]}`;
    return 'https://bookitmalta.com';
  }
  return process.env[envKey(slug, 'PUBLIC_BASE_URL')] || 'https://bookitmalta.com';
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
  getPublicBaseUrl,
  envKey,
};
