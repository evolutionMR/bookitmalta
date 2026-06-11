// api/captain.js
//
// Per-enquiry magic-link (existing):
//   GET  /api/captain?token=…&tenant=…                       → render action page
//   POST /api/captain                                        → confirm/decline
//
// Dashboard session auth (B2.2, new):
//   POST /api/captain?mode=login&tenant=…                    → send magic link
//   GET  /api/captain?mode=auth&token=…&tenant=…             → set session cookie
//   POST /api/captain?mode=logout                            → clear session cookie
//
// Magic-link auth: per-enquiry tokens grant single-use confirm/decline; the
// captain dashboard uses a 7-day HttpOnly session cookie issued after a
// 15-min one-time-use login token from the dashboard sign-in flow.

const { resolveTenant, getTenantEnv, getTenantEnvOptional } = require('./_lib/tenant.js');
const { getSupabase } = require('./_lib/supabase.js');
const {
  createDepositPaymentLink,
  deactivatePaymentLink,
} = require('./_lib/stripe.js');
const {
  sendEmail,
  customerDepositLinkEmail,
  customerDeclineEmail,
  captainActionConfirmedEmail,
  captainLoginMagicLinkEmail,
} = require('./_lib/resend.js');
const {
  issueLoginToken,
  verifyLoginToken,
  issueSessionToken,
  buildSessionCookie,
  buildClearCookie,
  getCaptainFromRequest,
  isAllowed,
  LOGIN_TOKEN_TTL_SECS,
} = require('./_lib/captain-auth.js');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  // ---------- DASHBOARD AUTH SUB-ROUTES (B2.2) ----------
  // ?mode=login | auth | logout | me — handled before the per-enquiry token path.
  const mode = (req.query && req.query.mode) || null;
  if (mode === 'login')  return await handleLogin(req, res);
  if (mode === 'auth')   return await handleAuth(req, res);
  if (mode === 'logout') return await handleLogout(req, res);
  if (mode === 'me')     return await handleMe(req, res);

  // ---------- PER-ENQUIRY MAGIC LINK (existing) ----------
  let tenant, config;
  try {
    ({ slug: tenant, config } = resolveTenant(req));
  } catch (e) {
    return htmlError(res, 400, 'Missing or unknown tenant');
  }

  const token  = (req.query && req.query.token)  || (req.body && req.body.token);
  // Mutations only on POST. Email security scanners (Outlook ATP Safe Links,
  // Gmail link-preview) fetch URLs on GET and would otherwise auto-confirm
  // enquiries before the captain ever reads the email. GET requests fall
  // through to the review-page render, which has the POST form.
  const action = (req.method === 'POST') ? (req.body && req.body.action) : null;
  const note   = (req.body && req.body.note)     || null;

  if (!token) return htmlError(res, 400, 'Missing token');

  const supabase = getSupabase(tenant);

  // Look up enquiry by token
  const { data: enquiry, error: lookupErr } = await supabase
    .from('enquiries')
    .select('*')
    .eq('captain_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('[captain] lookup error:', lookupErr);
    return htmlError(res, 500, 'Server error');
  }
  if (!enquiry) {
    return htmlError(res, 404, 'Enquiry not found or link expired');
  }

  // Already actioned?
  if (enquiry.status !== 'received') {
    return htmlAlreadyActioned(res, enquiry, config);
  }

  // ---- ACT ----
  if (action === 'confirm') {
    return await doConfirm({ supabase, tenant, config, enquiry, note, res });
  }
  if (action === 'decline') {
    return await doDecline({ supabase, tenant, config, enquiry, note, res });
  }

  // ---- DEFAULT (no action) → render review page ----
  return htmlReviewPage(res, enquiry, config, tenant);
};

// =============================================================================
// CONFIRM
// =============================================================================
async function doConfirm({ supabase, tenant, config, enquiry, note, res }) {
  const baseUrl = getTenantEnvOptional(tenant, 'PUBLIC_BASE_URL', 'https://bookitmalta.com');
  // Point Stripe at the dedicated post-payment confirmation page so the
  // customer sees a celebratory "✓ Confirmed" screen with Add-to-Calendar
  // buttons immediately after paying, instead of landing back on the
  // operator page with no visible confirmation. All booking data is passed
  // in query params so the page can render without a DB lookup (and so the
  // URL is shareable/refreshable across the customer's devices).
  const successParams = new URLSearchParams({
    tenant,
    code:  String(enquiry.id || '').replace(/-/g, '').slice(0, 8).toUpperCase(),
    date:  enquiry.preferred_date || '',
    slot:  enquiry.tour_option || '',
    party: String(enquiry.party_size || 1),
  });
  const successUrl = `${baseUrl}/booking-confirmed?${successParams.toString()}`;

  let paymentLink;
  try {
    paymentLink = await createDepositPaymentLink({
      tenantSlug: tenant,
      tenantConfig: config,
      enquiry,
      successUrl,
    });
  } catch (e) {
    console.error('[captain] Stripe Payment Link creation failed:', e);
    return htmlError(res, 500,
      'Could not create Stripe payment link. The enquiry has NOT been confirmed — please refresh and try again, or contact BookItMalta if this persists.'
    );
  }

  // Update enquiry → confirmed. Gate on status='received' so concurrent
  // clicks (or a scanner+captain race) can't both create Payment Links —
  // only the first request wins; the loser cleans up its Stripe link.
  const { data: updated, error: updErr } = await supabase
    .from('enquiries')
    .update({
      status:                  'confirmed',
      captain_action_at:       new Date().toISOString(),
      captain_note:            note,
      stripe_payment_link_id:  paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
      stripe_link_expires_at:  paymentLink.expiresAt.toISOString(),
    })
    .eq('id', enquiry.id)
    .eq('status', 'received')
    .select();

  if (updErr) {
    console.error('[captain] update error:', updErr);
    try { await deactivatePaymentLink(tenant, paymentLink.id); } catch {}
    return htmlError(res, 500, 'Could not update enquiry. Payment link revoked. Please try again.');
  }

  if (!updated || updated.length === 0) {
    // Lost the race — another request confirmed first. Deactivate our orphan link.
    console.warn('[captain] confirm race — enquiry already actioned by another request', enquiry.id);
    try { await deactivatePaymentLink(tenant, paymentLink.id); } catch {}
    return htmlError(res, 409, 'This enquiry was already actioned. The duplicate payment link has been deactivated.');
  }

  // Email customer the deposit link
  try {
    const msg = customerDepositLinkEmail({
      tenantConfig: config,
      enquiry,
      paymentUrl: paymentLink.url,
    });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: enquiry.customer_email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[captain] customer deposit email failed:', e);
    // The link exists; manual recovery possible via Resend dashboard.
  }

  // Email captain confirming the action was recorded
  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    const msg = captainActionConfirmedEmail({ tenantConfig: config, enquiry, action: 'confirm' });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: captainEmailAddr,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[captain] captain ack email failed:', e);
  }

  return htmlSuccess(res, {
    title: 'Confirmed',
    body: `Payment link sent to <strong>${escapeHtml(enquiry.customer_email)}</strong>.<br><br>You'll receive a "BOOKED" notification the moment the booking fee lands.`,
    config,
  });
}

// =============================================================================
// DECLINE
// =============================================================================
async function doDecline({ supabase, tenant, config, enquiry, note, res }) {
  // Gate on status='received' for the same reason the confirm path does —
  // a confirm+decline race from two tabs could otherwise overwrite a
  // just-confirmed enquiry (after we've already emailed the deposit link).
  const { data: updated, error: updErr } = await supabase
    .from('enquiries')
    .update({
      status:            'declined',
      captain_action_at: new Date().toISOString(),
      captain_note:      note,
    })
    .eq('id', enquiry.id)
    .eq('status', 'received')
    .select();

  if (updErr) {
    console.error('[captain] decline update error:', updErr);
    return htmlError(res, 500, 'Could not update enquiry. Please try again.');
  }

  if (!updated || updated.length === 0) {
    console.warn('[captain] decline race — enquiry already actioned by another request', enquiry.id);
    return htmlError(res, 409, 'This enquiry was already actioned. The decline was not applied.');
  }

  try {
    const msg = customerDeclineEmail({ tenantConfig: config, enquiry, captainNote: note });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: enquiry.customer_email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[captain] customer decline email failed:', e);
  }

  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    const msg = captainActionConfirmedEmail({ tenantConfig: config, enquiry, action: 'decline' });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: captainEmailAddr,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[captain] captain ack email failed:', e);
  }

  return htmlSuccess(res, {
    title: 'Declined',
    body: `The customer has been notified that this date isn't available.`,
    config,
  });
}

// =============================================================================
// HTML rendering — server-side, minimal, branded
// =============================================================================
function htmlPage({ title, body, config }) {
  const tenantName = config?.name || 'BookItMalta';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — ${escapeHtml(tenantName)}</title>
<style>
  :root {
    --ink:#0B2545; --paper:#F4EBD9; --terracotta:#C85C2E;
    --sea:#3D6B6F; --rule:rgba(11,37,69,.12);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
       font-family:'Manrope',system-ui,sans-serif;line-height:1.55;
       padding:2rem;min-height:100vh}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid var(--rule);
        border-radius:6px;padding:2.4rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  h1{font-family:'Fraunces',Georgia,serif;font-weight:500;font-size:1.6rem;
     margin:0 0 1.2rem;color:var(--ink)}
  .kicker{font-family:'JetBrains Mono',monospace;font-size:.72rem;letter-spacing:.08em;
          text-transform:uppercase;color:var(--terracotta);margin-bottom:.5rem;display:block}
  p{margin:0 0 1rem}
  .meta{display:grid;grid-template-columns:9rem 1fr;gap:.4rem 1rem;
        font-size:.94rem;margin:1.4rem 0;padding:1.2rem 0;
        border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
  .meta dt{font-family:'JetBrains Mono',monospace;font-size:.78rem;
           letter-spacing:.05em;text-transform:uppercase;color:var(--sea);margin:0}
  .meta dd{margin:0;color:var(--ink)}
  .actions{display:flex;gap:.8rem;margin-top:1.6rem;flex-wrap:wrap}
  .btn{display:inline-block;padding:.8rem 1.4rem;border-radius:4px;
       font-family:inherit;font-size:.95rem;font-weight:600;text-decoration:none;
       border:1px solid transparent;cursor:pointer}
  .btn-confirm{background:var(--terracotta);color:var(--paper)}
  .btn-decline{background:transparent;color:var(--ink);border-color:var(--rule)}
  textarea{width:100%;padding:.7rem;border:1px solid var(--rule);border-radius:4px;
           font-family:inherit;font-size:.94rem;color:var(--ink);background:var(--paper);
           margin-top:.4rem;min-height:80px;resize:vertical}
  label{font-family:'JetBrains Mono',monospace;font-size:.74rem;
        letter-spacing:.05em;text-transform:uppercase;color:var(--sea);
        display:block;margin-top:1rem}
  .footer{margin-top:2rem;font-size:.82rem;color:rgba(11,37,69,.6);text-align:center}
</style>
</head>
<body>
<div class="wrap">
  ${body}
  <p class="footer">${escapeHtml(tenantName)} · via BookItMalta</p>
</div>
</body>
</html>`;
}

function htmlReviewPage(res, enquiry, config, tenant) {
  const body = `
    <span class="kicker">New enquiry</span>
    <h1>${escapeHtml(enquiry.customer_name)}</h1>
    <p>Review the details below and choose an action. Confirming will send the customer a payment link for the BookItMalta booking fee. Declining will email an apology.</p>

    <dl class="meta">
      <dt>Email</dt>      <dd><a href="mailto:${escapeHtml(enquiry.customer_email)}" style="color:var(--terracotta);text-decoration:none">${escapeHtml(enquiry.customer_email)}</a></dd>
      <dt>Phone</dt>      <dd>${escapeHtml(enquiry.customer_phone || '—')}</dd>
      <dt>Date</dt>       <dd>${escapeHtml(formatDate(enquiry.preferred_date))}</dd>
      <dt>Alternative</dt><dd>${escapeHtml(enquiry.alt_dates || '—')}</dd>
      <dt>Party size</dt> <dd>${enquiry.party_size}</dd>
      ${enquiry.tour_option ? `<dt>Tour</dt><dd>${escapeHtml(enquiry.tour_option)}</dd>` : ''}
      <dt>Message</dt>    <dd style="white-space:pre-wrap">${escapeHtml(enquiry.message || '—')}</dd>
    </dl>

    <form method="POST" action="/api/captain">
      <input type="hidden" name="token" value="${escapeHtml(enquiry.captain_token)}" />
      <input type="hidden" name="tenant" value="${escapeHtml(tenant)}" />

      <label for="note">Internal note (optional — visible to you only)</label>
      <textarea id="note" name="note" placeholder="e.g. weather looks good, prefer Comino route…"></textarea>

      <div class="actions">
        <button class="btn btn-confirm" type="submit" name="action" value="confirm">Confirm & send payment link</button>
        <button class="btn btn-decline" type="submit" name="action" value="decline">Decline</button>
      </div>
    </form>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).send(htmlPage({ title: 'Review enquiry', body, config }));
}

function htmlAlreadyActioned(res, enquiry, config) {
  const body = `
    <span class="kicker">Already actioned</span>
    <h1>This enquiry was already ${escapeHtml(enquiry.status)}</h1>
    <p>You ${enquiry.captain_action_at ? `acted on this enquiry on ${escapeHtml(new Date(enquiry.captain_action_at).toLocaleString('en-GB'))}` : 'have already actioned this enquiry'}. To reverse the decision, contact BookItMalta directly — magic-link actions are single-use for safety.</p>
    <dl class="meta">
      <dt>Customer</dt>   <dd>${escapeHtml(enquiry.customer_name)}</dd>
      <dt>Email</dt>      <dd>${escapeHtml(enquiry.customer_email)}</dd>
      <dt>Date</dt>       <dd>${escapeHtml(formatDate(enquiry.preferred_date))}</dd>
      <dt>Status</dt>     <dd>${escapeHtml(enquiry.status)}</dd>
    </dl>
  `;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).send(htmlPage({ title: 'Already actioned', body, config }));
}

function htmlSuccess(res, { title, body, config }) {
  const html = htmlPage({
    title,
    body: `
      <span class="kicker">Done</span>
      <h1>${escapeHtml(title)}</h1>
      <p>${body}</p>
    `,
    config,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(200).send(html);
}

function htmlError(res, code, message) {
  const html = htmlPage({
    title: 'Error',
    body: `
      <span class="kicker">Error</span>
      <h1>Something went wrong</h1>
      <p>${escapeHtml(message)}</p>
    `,
    config: null,
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(code).send(html);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(isoDate) {
  try {
    return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

// =============================================================================
// B2.2 — DASHBOARD AUTH (login / auth / logout)
// =============================================================================

/**
 * POST /api/captain?mode=login
 * Body (JSON or x-www-form-urlencoded): { tenant, email }
 *
 * Validates email against tenant.captainAllowlist (case-insensitive),
 * sends a magic-link email containing a 15-min one-time-use login token.
 * Returns 200 even on unknown email so we don't leak which addresses are
 * on the allowlist (anti-enumeration).
 */
async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'Method not allowed');
  }

  // Allow tenant + email from JSON OR form body (works whether the login
  // page submits via fetch JSON or native form POST).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* leave string */ }
  }
  const tenant = (body && body.tenant) || (req.query && req.query.tenant);
  const email  = (body && body.email)  || (req.query && req.query.email);

  if (!tenant || typeof tenant !== 'string') {
    return jsonError(res, 400, 'Missing tenant');
  }
  if (!email || typeof email !== 'string' || !/^.+@.+\..+$/.test(email)) {
    return jsonError(res, 400, 'Invalid email');
  }

  let config;
  try {
    const { getTenant } = require('../config/tenants.js');
    config = getTenant(tenant);
  } catch (e) {
    return jsonError(res, 400, 'Unknown tenant');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const ipHashShort = ipHashFromReq(req);

  // Anti-enumeration: always return 200 even if the email is NOT on the
  // allowlist. Just don't actually send anything.
  if (!isAllowed(config, normalizedEmail)) {
    console.log('[captain-auth] login attempt for non-allowlisted email', {
      tenant,
      email_hash: hashEmail(normalizedEmail),
      ipHashShort,
    });
    return res.status(200).json({ ok: true });
  }

  // Mint the login token + build the magic URL.
  // Derive baseUrl from the request's host so magic links route back to
  // whatever deployment received the login (production OR vercel preview).
  // Without this, preview testing breaks because previews issue links to
  // production where the new B2.2 code doesn't exist yet. Host header is
  // allowlisted to prevent injection: bookitmalta.com + *.vercel.app only.
  const token = issueLoginToken({ tenant, email: normalizedEmail });
  const baseUrl = deriveMagicLinkBaseUrl(req, tenant);
  const magicUrl = `${baseUrl}/api/captain?mode=auth&token=${encodeURIComponent(token)}&tenant=${encodeURIComponent(tenant)}`;

  try {
    const msg = captainLoginMagicLinkEmail({
      tenantConfig: config,
      magicUrl,
      requesterEmail: normalizedEmail,
      ipHashShort,
      expiresInMinutes: Math.round(LOGIN_TOKEN_TTL_SECS / 60),
    });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: normalizedEmail,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[captain-auth] login email send failed:', e);
    // Still 200 to anti-enumerate — operator can request again if no email
    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
}

/**
 * GET /api/captain?mode=auth&token=…&tenant=…
 *
 * Magic-link click. Verifies the login token, mints a 7-day session JWT,
 * sets it as an HttpOnly cookie, and 302-redirects to /captain/dashboard.
 *
 * If the token is expired or malformed, redirects to /captain/login with
 * an error query param so the user can request a new link.
 */
async function handleAuth(req, res) {
  if (req.method !== 'GET') {
    return jsonError(res, 405, 'Method not allowed');
  }

  const token = req.query && req.query.token;
  if (!token) return redirectToLogin(res, 'missing_token');

  let payload;
  try {
    payload = verifyLoginToken(token);
  } catch (e) {
    return redirectToLogin(res, 'expired');
  }

  // Defense in depth: re-check the allowlist at click-time, in case the
  // allowlist changed between link-issuance and click.
  let config;
  try {
    const { getTenant } = require('../config/tenants.js');
    config = getTenant(payload.tenant);
  } catch {
    return redirectToLogin(res, 'unknown_tenant');
  }
  if (!isAllowed(config, payload.email)) {
    return redirectToLogin(res, 'not_allowed');
  }

  const sessionToken = issueSessionToken({ tenant: payload.tenant, email: payload.email });
  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.setHeader('Location', '/captain/dashboard');
  return res.status(302).end();
}

/**
 * POST or GET /api/captain?mode=logout
 * Clears the captain session cookie + redirects to /captain/login.
 */
async function handleLogout(req, res) {
  res.setHeader('Set-Cookie', buildClearCookie());
  res.setHeader('Location', '/captain/login');
  return res.status(302).end();
}

/**
 * GET /api/captain?mode=me
 * Returns { email, tenant, tenant_name } for the current session, or 401.
 * Used by the dashboard to render "Signed in as …" without server-side render.
 */
async function handleMe(req, res) {
  const session = getCaptainFromRequest(req);
  if (!session) return jsonError(res, 401, 'Not signed in');

  // Resolve tenant name for the dashboard header. Tolerate missing tenant
  // (returns 401-ish so the dashboard bounces back to /captain/login).
  let tenantName = null;
  try {
    const { getTenant } = require('../config/tenants.js');
    tenantName = getTenant(session.tenant).name;
  } catch {
    return jsonError(res, 401, 'Unknown tenant in session');
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({
    email:       session.email,
    tenant:      session.tenant,
    tenant_name: tenantName,
  });
}

// -----------------------------------------------------------------------------
// auth helpers
// -----------------------------------------------------------------------------
function jsonError(res, status, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json({ error: message });
}

function redirectToLogin(res, errorCode) {
  res.setHeader('Location', `/captain/login?error=${encodeURIComponent(errorCode)}`);
  return res.status(302).end();
}

function ipHashFromReq(req) {
  const ip = ((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',')[0].trim() || null;
  if (!ip) return null;
  try {
    return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Derive the base URL the magic link should point to. Prefers the request's
 * own host so production hits → production link, preview hits → preview link.
 *
 * Host-header injection guard: we only honor hosts on a small allowlist
 * (bookitmalta.com + any *.vercel.app preview). Unknown hosts fall back to
 * the tenant's PUBLIC_BASE_URL env var, then to production bookitmalta.com.
 *
 * This means: an attacker who manages to inject a malicious Host header
 * still can't make the magic link point to attacker-controlled domains.
 */
function deriveMagicLinkBaseUrl(req, tenant) {
  const h = req.headers || {};
  const proto = String(h['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();

  const isAllowed =
    host === 'bookitmalta.com' ||
    host === 'www.bookitmalta.com' ||
    /^[a-z0-9-]+\.vercel\.app$/.test(host);

  if (isAllowed) return `${proto}://${host}`;

  // Fallback paths — tenant env var, then hard default.
  return getTenantEnvOptional(tenant, 'PUBLIC_BASE_URL', 'https://bookitmalta.com');
}

function hashEmail(email) {
  try {
    return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}
