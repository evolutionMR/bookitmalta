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
  isValidPin,
  hashPin,
  verifyPin,
  PIN_MAX_ATTEMPTS,
  PIN_LOCKOUT_MINUTES,
} = require('./_lib/captain-auth.js');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  // ---------- DASHBOARD AUTH SUB-ROUTES (B2.2) ----------
  // ?mode=login | auth | logout | me — handled before the per-enquiry token path.
  // ?mode=dashboard-data — B2.3 read-only data feed for /captain/dashboard.
  const mode = (req.query && req.query.mode) || null;
  if (mode === 'login')          return await handleLogin(req, res);
  if (mode === 'auth')           return await handleAuth(req, res);
  if (mode === 'logout')         return await handleLogout(req, res);
  if (mode === 'me')             return await handleMe(req, res);
  if (mode === 'pin-login')      return await handlePinLogin(req, res);
  if (mode === 'pin-set')        return await handlePinSet(req, res);
  if (mode === 'dashboard-data') return await handleDashboardData(req, res);

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
  const email  = (body && body.email)  || (req.query && req.query.email);
  if (!email || typeof email !== 'string' || !/^.+@.+\..+$/.test(email)) {
    return jsonError(res, 400, 'Invalid email');
  }
  // Operator is derived from the email's allowlist membership — no picker.
  const tenant = (body && body.tenant) || (req.query && req.query.tenant) || resolveTenantByEmail(email);
  if (!tenant || typeof tenant !== 'string') {
    return res.status(200).json({ ok: true }); // anti-enumeration: don't reveal unknown emails
  }

  let config;
  try {
    const { getTenant } = require('../config/tenants.js');
    config = getTenant(tenant);
  } catch (e) {
    return res.status(200).json({ ok: true });
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

// =============================================================================
// EMAIL + PIN auth — fast re-entry on a known device
// =============================================================================
// PINs live in each tenant's `captain_pins` table (service-role only). Issued
// at onboarding with must_change=true. Magic-link (mode=login) is the reset path.

function pinBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* leave */ } }
  return body || {};
}

function resolveTenantByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  try {
    const { TENANTS } = require('../config/tenants.js');
    for (const slug of Object.keys(TENANTS)) {
      const al = TENANTS[slug].captainAllowlist;
      if (Array.isArray(al) && al.some((x) => String(x).trim().toLowerCase() === e)) return slug;
    }
  } catch { /* ignore */ }
  return null;
}

function resolvePinTenant(body, req) {
  // Operator is derived from the email's allowlist membership — no picker needed.
  let tenant = (body && body.tenant) || (req.query && req.query.tenant);
  if (!tenant) tenant = resolveTenantByEmail(body && body.email);
  if (!tenant || typeof tenant !== 'string') return { error: 'We could not find an operator for that email.' };
  try {
    const { getTenant } = require('../config/tenants.js');
    return { tenant, config: getTenant(tenant) };
  } catch {
    return { error: 'Unknown tenant' };
  }
}

/**
 * POST /api/captain?mode=pin-login  { tenant, email, pin }
 * Verifies email+PIN against captain_pins (rate-limited, locks after N tries).
 * On success: sets session cookie — unless must_change, in which case it
 * returns { mustChange: true } so the client collects a new PIN via pin-set.
 * Generic 401 ("Wrong email or PIN") to avoid revealing which is wrong.
 */
async function handlePinLogin(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');
  const body = pinBody(req);
  const { tenant, config, error } = resolvePinTenant(body, req);
  if (error) return jsonError(res, 400, error);

  const email = String((body && body.email) || '').trim().toLowerCase();
  const pin   = String((body && body.pin) || '');

  // Validate shape + allowlist behind one generic error.
  if (!/^.+@.+\..+$/.test(email) || !isValidPin(pin) || !isAllowed(config, email)) {
    return jsonError(res, 401, 'Wrong email or PIN');
  }

  let supa;
  try { supa = getSupabase(tenant); }
  catch { return jsonError(res, 500, 'Sign-in is not available for this operator yet.'); }

  const { data: row, error: dbErr } = await supa
    .from('captain_pins').select('*').eq('email', email).maybeSingle();
  if (dbErr) {
    console.error('[captain-auth] pin-login db error:', dbErr.message || dbErr);
    return jsonError(res, 500, 'Could not sign you in right now.');
  }

  const now = Date.now();
  if (row && row.locked_until && new Date(row.locked_until).getTime() > now) {
    return jsonError(res, 429, 'Too many attempts. Try again later, or use “Forgot PIN”.');
  }

  if (!row || !verifyPin(pin, row.pin_hash, row.pin_salt)) {
    if (row) {
      const attempts = (row.failed_attempts || 0) + 1;
      const patch = { failed_attempts: attempts, updated_at: new Date().toISOString() };
      if (attempts >= PIN_MAX_ATTEMPTS) {
        patch.failed_attempts = 0;
        patch.locked_until = new Date(now + PIN_LOCKOUT_MINUTES * 60000).toISOString();
      }
      await supa.from('captain_pins').update(patch).eq('email', email);
    }
    return jsonError(res, 401, 'Wrong email or PIN');
  }

  // Correct PIN — clear the attempt counter.
  await supa.from('captain_pins')
    .update({ failed_attempts: 0, locked_until: null }).eq('email', email);

  if (row.must_change) {
    // No session yet — client must set a new PIN first (pin-set with currentPin).
    return res.status(200).json({ ok: true, mustChange: true });
  }

  res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken({ tenant, email })));
  return res.status(200).json({ ok: true });
}

/**
 * POST /api/captain?mode=pin-set  { tenant, email, newPin, currentPin? }
 * Sets/changes the PIN. Authorised by EITHER a valid session cookie for this
 * tenant+email (the magic-link "forgot PIN" reset path) OR a correct currentPin
 * (first-login forced change / voluntary change). On success: sets session.
 */
async function handlePinSet(req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'Method not allowed');
  const body = pinBody(req);
  const { tenant, config, error } = resolvePinTenant(body, req);
  if (error) return jsonError(res, 400, error);

  const email      = String((body && body.email) || '').trim().toLowerCase();
  const currentPin = String((body && body.currentPin) || '');
  const newPin     = String((body && body.newPin) || '');

  if (!/^.+@.+\..+$/.test(email) || !isAllowed(config, email)) {
    return jsonError(res, 403, 'Not allowed');
  }
  if (!isValidPin(newPin)) {
    return jsonError(res, 400, 'PIN must be 4–6 digits.');
  }

  let supa;
  try { supa = getSupabase(tenant); }
  catch { return jsonError(res, 500, 'Not available for this operator yet.'); }

  const { data: row } = await supa
    .from('captain_pins').select('*').eq('email', email).maybeSingle();

  // Authorise: a valid session (forgot-PIN reset via magic link) bypasses the
  // currentPin check; otherwise the current PIN must match.
  const sess = getCaptainFromRequest(req);
  const sessionOk = !!(sess && sess.tenant === tenant && sess.email === email);
  if (!sessionOk) {
    if (!row || !verifyPin(currentPin, row.pin_hash, row.pin_salt)) {
      return jsonError(res, 401, 'Current PIN is incorrect.');
    }
    if (newPin === currentPin) {
      return jsonError(res, 400, 'Please choose a PIN different from the one we sent you.');
    }
  }

  const { hash, salt } = hashPin(newPin);
  const { error: upErr } = await supa.from('captain_pins').upsert({
    email,
    pin_hash: hash,
    pin_salt: salt,
    must_change: false,
    failed_attempts: 0,
    locked_until: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'email' });
  if (upErr) {
    console.error('[captain-auth] pin-set db error:', upErr.message || upErr);
    return jsonError(res, 500, 'Could not save your PIN. Please try again.');
  }

  res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken({ tenant, email })));
  return res.status(200).json({ ok: true });
}

/**
 * GET /api/captain?mode=dashboard-data
 *
 * B2.3 — Returns the read-only operations view for the captain dashboard.
 * Reads from the tenant's bookings table + get_departure_availability RPC
 * (the source of truth defined in B2.1) so cap-overrides + schedule rules
 * are honored automatically.
 *
 * Default window: today + next 13 days (14 days total).
 * Response shape:
 *   {
 *     tenant: 'adventure-cruises',
 *     tenant_name: 'Adventure Cruises',
 *     scheduling_model: 'multi_slot_per_day' | 'single_slot_per_day',
 *     today_iso: '2026-06-11',
 *     days: [
 *       {
 *         date: '2026-06-11',
 *         dow: 4,  // 0=Sun
 *         slots: [
 *           {
 *             slot_time: '09:30',
 *             total_cap: 80,
 *             seats_taken: 1,
 *             seats_available: 79,
 *             is_blocked: false,
 *             block_reason: null,
 *             bookings: [
 *               { id, customer_name, party_size, customer_email,
 *                 customer_phone, status, source, tour_option }
 *             ]
 *           }
 *         ]
 *       },
 *       …
 *     ]
 *   }
 */
async function handleDashboardData(req, res) {
  const session = getCaptainFromRequest(req);
  if (!session) return jsonError(res, 401, 'Not signed in');

  let config;
  try {
    const { getTenant } = require('../config/tenants.js');
    config = getTenant(session.tenant);
  } catch {
    return jsonError(res, 401, 'Unknown tenant in session');
  }

  const supabase = getSupabase(session.tenant);

  // Build the date window — today + 13 future days in Malta local time.
  // Vercel runtimes are UTC; format the date in Europe/Malta to avoid
  // showing "yesterday" to Tony when he opens the dashboard after midnight UTC
  // but before midnight Malta (which is ~01:00 UTC in summer).
  const nowMalta = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Malta' })
  );
  const fmtIso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(nowMalta);
    d.setDate(d.getDate() + i);
    days.push({ date: fmtIso(d), dow: d.getDay() });
  }
  const startDate = days[0].date;
  const endDate   = days[days.length - 1].date;

  // Resolve the slot list per tenant. AC has explicit slots; Bandama has one
  // implicit slot per day (the whole-boat charter). Single_slot tenants get
  // an empty slot string so manifest rendering stays uniform.
  const isMulti = config.schedulingModel === 'multi_slot_per_day';
  const slots = isMulti
    ? (Array.isArray(config.departureSlots) ? config.departureSlots : [])
    : [''];

  // Pull every confirmed/completed booking in the window in one query.
  // Filter to bookings that consume capacity ('booked'|'completed') — same
  // status set used by get_departure_availability.
  // Note: bookings table does NOT have a 'source' column (it's on enquiries).
  // If we need source on the dashboard later, JOIN bookings → enquiries
  // by enquiry_id. For B2.3 we drop it.
  const { data: bookings, error: bookErr } = await supabase
    .from('bookings')
    .select('id, enquiry_id, customer_name, party_size, customer_email, customer_phone, charter_date, slot_time, tour_option, status, created_at')
    .gte('charter_date', startDate)
    .lte('charter_date', endDate)
    .in('status', ['booked', 'completed'])
    .order('charter_date', { ascending: true })
    .order('slot_time',    { ascending: true })
    .order('created_at',   { ascending: true });

  if (bookErr) {
    console.error('[captain] dashboard-data bookings select error', bookErr);
    return jsonError(res, 500, 'Could not load bookings');
  }

  // Index bookings by (date, slot) so we can attach them to slot cells.
  const bookingsByKey = {};
  for (const b of bookings || []) {
    const slotKey = isMulti ? (b.slot_time || b.tour_option || '') : '';
    const key = `${b.charter_date}|${slotKey}`;
    if (!bookingsByKey[key]) bookingsByKey[key] = [];
    bookingsByKey[key].push(b);
  }

  // For each (date, slot) compute availability. Single_slot tenants don't
  // have get_departure_availability yet (it's AC-only), so we synthesize the
  // numbers from the booking count for those.
  const result = [];
  for (const day of days) {
    const slotsOut = [];
    for (const slotTime of slots) {
      const key = `${day.date}|${slotTime}`;
      const bookingList = bookingsByKey[key] || [];
      const seats_taken = bookingList.reduce(
        (s, b) => s + (Number(b.party_size) || 0),
        0
      );

      let total_cap = isMulti ? 80 : 1;
      let seats_available = total_cap - seats_taken;
      let is_blocked = false;
      let block_reason = null;

      if (isMulti) {
        // Source of truth for AC — read get_departure_availability.
        // Pass party_size=1 just to drive the function; we only care about
        // the cap/seats/blocked fields, not can_accommodate.
        const { data: availRows, error: availErr } = await supabase
          .rpc('get_departure_availability', {
            p_date:       day.date,
            p_slot:       slotTime,
            p_party_size: 1,
          });
        if (availErr) {
          console.error('[captain] dashboard-data availability error', { date: day.date, slot: slotTime, availErr });
        } else if (Array.isArray(availRows) && availRows[0]) {
          const a = availRows[0];
          total_cap       = a.total_cap;
          seats_available = a.seats_available;
          is_blocked      = !!a.is_blocked;
          block_reason    = a.block_reason || null;
          // Trust the RPC's seats_taken over the manual sum — it filters by
          // the same status set but covers any drift between table joins.
          // Defensive: only override if RPC's count is plausible.
          if (typeof a.seats_taken === 'number') {
            // No-op — keep our own count which matched bookingList.
            // (Both come from the same source data.)
          }
        }
      }

      slotsOut.push({
        slot_time:        slotTime || null,
        total_cap,
        seats_taken,
        seats_available:  Math.max(0, seats_available),
        is_blocked,
        block_reason,
        bookings: bookingList.map((b) => ({
          id:             b.id,
          customer_name:  b.customer_name,
          party_size:     b.party_size,
          customer_email: b.customer_email,
          customer_phone: b.customer_phone,
          status:         b.status,
        })),
      });
    }
    result.push({ date: day.date, dow: day.dow, slots: slotsOut });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    tenant:           session.tenant,
    tenant_name:      config.name,
    scheduling_model: config.schedulingModel || 'single_slot_per_day',
    today_iso:        startDate,
    days:             result,
  });
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
