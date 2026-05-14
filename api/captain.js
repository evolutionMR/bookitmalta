// api/captain.js
//
// GET  /api/captain?token=...&tenant=...                       → render action page
// GET  /api/captain?token=...&tenant=...&action=confirm        → one-click confirm
// GET  /api/captain?token=...&tenant=...&action=decline        → one-click decline
// POST /api/captain                                            → from action page form
//
// Magic-link auth: the captain's email contains opaque per-enquiry tokens.
// Knowing the token grants ability to confirm/decline that enquiry. Token
// is rotated to a single-use status by setting captain_action_at — once
// acted, the link returns "already actioned" instead of letting the
// captain reverse the decision via the same URL.

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
} = require('./_lib/resend.js');

module.exports = async function handler(req, res) {
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
  const successUrl = `${baseUrl}${config.publicPagePath}#payment-received`;

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
    body: `Stripe deposit link sent to <strong>${escapeHtml(enquiry.customer_email)}</strong>.<br><br>You'll receive a "BOOKED" notification the moment the deposit lands.`,
    config,
  });
}

// =============================================================================
// DECLINE
// =============================================================================
async function doDecline({ supabase, tenant, config, enquiry, note, res }) {
  const { error: updErr } = await supabase
    .from('enquiries')
    .update({
      status:            'declined',
      captain_action_at: new Date().toISOString(),
      captain_note:      note,
    })
    .eq('id', enquiry.id);

  if (updErr) {
    console.error('[captain] decline update error:', updErr);
    return htmlError(res, 500, 'Could not update enquiry. Please try again.');
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
    <p>Review the details below and choose an action. Confirming will send a Stripe deposit link to the customer. Declining will email an apology.</p>

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
        <button class="btn btn-confirm" type="submit" name="action" value="confirm">Confirm & send deposit link</button>
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
