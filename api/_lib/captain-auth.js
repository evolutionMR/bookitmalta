// api/_lib/captain-auth.js
//
// Captain dashboard auth — magic-link-issued HttpOnly session cookies.
//
// Flow:
//   1. Operator enters email on /captain/login → POST /api/captain?mode=login
//   2. captain.js validates email is on the tenant's captainAllowlist
//   3. captain.js sends a magic-link email containing a short-lived (15-min)
//      one-time-use login token signed with CAPTAIN_AUTH_SECRET
//   4. Operator clicks link → GET /api/captain?mode=auth&token=…
//   5. captain.js verifies the login token, sets a session JWT cookie
//      (HttpOnly, Secure, SameSite=Lax, 7-day expiry), redirects to
//      /captain/dashboard
//   6. /captain/dashboard renders; subsequent API calls send the cookie
//      automatically. captain.js (or future /api/admin/*) calls
//      getCaptainFromRequest() to extract { tenant, email } from the cookie.
//
// We use a custom HMAC-SHA256 JWT implementation (no jsonwebtoken dep) to
// keep the dependency surface small for this money-handling app. Two token
// types are issued, distinguished by the `t` claim:
//   - "login"  → 15-min, one-time-use, embedded in magic link
//   - "session" → 7-day, HttpOnly cookie
//
// CAPTAIN_AUTH_SECRET is a shared env var across tenants — the JWT payload
// includes the tenant slug, so cross-tenant token reuse is impossible.

const crypto = require('crypto');

const COOKIE_NAME           = '__bim_captain';
const SESSION_TTL_SECONDS   = 7 * 24 * 60 * 60;     // 7 days
const LOGIN_TOKEN_TTL_SECS  = 15 * 60;              // 15 minutes
const ALG                   = 'HS256';

function getSecret() {
  const secret = process.env.CAPTAIN_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'CAPTAIN_AUTH_SECRET is missing or too short (need >=32 chars). ' +
      'Generate with: openssl rand -hex 32'
    );
  }
  return secret;
}

// -----------------------------------------------------------------------------
// base64url helpers (no padding per RFC 7515)
// -----------------------------------------------------------------------------
function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4;
  const padded = str + (pad ? '='.repeat(4 - pad) : '');
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signHmac(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest();
}

// -----------------------------------------------------------------------------
// JWT issue + verify
// -----------------------------------------------------------------------------
/**
 * @param {Object} payload
 * @param {number} ttlSeconds
 * @returns {string} compact JWT
 */
function signJwt(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: ALG, typ: 'JWT' };
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const hPart = b64urlEncode(JSON.stringify(header));
  const pPart = b64urlEncode(JSON.stringify(body));
  const signature = b64urlEncode(signHmac(`${hPart}.${pPart}`));
  return `${hPart}.${pPart}.${signature}`;
}

/**
 * Verify a JWT signature + expiry. Returns the payload, or throws.
 * Constant-time signature comparison.
 */
function verifyJwt(token) {
  if (typeof token !== 'string') throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [hPart, pPart, sigPart] = parts;
  const expectedSig = b64urlEncode(signHmac(`${hPart}.${pPart}`));

  const a = Buffer.from(sigPart);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Signature mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(pPart).toString('utf8'));
  } catch {
    throw new Error('Malformed payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new Error('Token expired');
  }
  return payload;
}

// -----------------------------------------------------------------------------
// Login token (short-lived, embedded in magic link)
// -----------------------------------------------------------------------------
function issueLoginToken({ tenant, email }) {
  return signJwt(
    { t: 'login', tenant, sub: email.toLowerCase() },
    LOGIN_TOKEN_TTL_SECS
  );
}

function verifyLoginToken(token) {
  const payload = verifyJwt(token);
  if (payload.t !== 'login') throw new Error('Wrong token type');
  if (!payload.tenant || !payload.sub) throw new Error('Missing claims');
  return { tenant: payload.tenant, email: payload.sub };
}

// -----------------------------------------------------------------------------
// Session token (long-lived, HttpOnly cookie)
// -----------------------------------------------------------------------------
function issueSessionToken({ tenant, email }) {
  return signJwt(
    { t: 'session', tenant, sub: email.toLowerCase() },
    SESSION_TTL_SECONDS
  );
}

function verifySessionToken(token) {
  const payload = verifyJwt(token);
  if (payload.t !== 'session') throw new Error('Wrong token type');
  if (!payload.tenant || !payload.sub) throw new Error('Missing claims');
  return { tenant: payload.tenant, email: payload.sub };
}

// -----------------------------------------------------------------------------
// Cookie helpers
// -----------------------------------------------------------------------------
/**
 * Build a Set-Cookie value for the session cookie.
 * HttpOnly  — JS can't read; mitigates XSS exfiltration.
 * Secure    — HTTPS only; safe to always send (prod is always HTTPS via Vercel).
 * SameSite=Lax — allows magic-link redirect from the email to deliver the
 *               cookie on first navigation. Blocks cross-site POSTs.
 * Path=/    — sent on /api/captain calls + all dashboard pages.
 */
function buildSessionCookie(token) {
  return [
    `${COOKIE_NAME}=${token}`,
    `Path=/`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

function buildClearCookie() {
  return [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

/**
 * Parse the captain session cookie out of a Vercel req. Returns the verified
 * { tenant, email } payload, or null if no valid cookie present.
 */
function getCaptainFromRequest(req) {
  const cookieHeader = (req.headers && req.headers.cookie) || '';
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

/**
 * Check that an email is on the tenant's captainAllowlist (case-insensitive).
 */
function isAllowed(tenantConfig, email) {
  if (!email) return false;
  if (!Array.isArray(tenantConfig.captainAllowlist)) return false;
  const e = String(email).trim().toLowerCase();
  return tenantConfig.captainAllowlist.some(
    (entry) => String(entry).trim().toLowerCase() === e
  );
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  LOGIN_TOKEN_TTL_SECS,
  issueLoginToken,
  verifyLoginToken,
  issueSessionToken,
  verifySessionToken,
  buildSessionCookie,
  buildClearCookie,
  getCaptainFromRequest,
  isAllowed,
};
