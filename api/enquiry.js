// api/enquiry.js
//
// POST /api/enquiry
//
// Receives a customer enquiry from a tenant page form. Decides:
//   • Is the requested date already booked?  → write to `waitlist`
//   • Otherwise                                → write to `enquiries`
// Then sends:
//   • captain notification email (with magic-link confirm/decline buttons)
//   • customer acknowledgement email (sets expectation: 24h captain reply)
//
// The form on the tenant page submits this with `tenant` field so we know
// which Supabase project + Stripe account + operator email to use.

const { resolveTenant } = require('./_lib/tenant.js');
const { getSupabase } = require('./_lib/supabase.js');
const { validateEnquiry, ValidationError } = require('./_lib/validation.js');
const {
  sendEmail,
  captainEnquiryEmail,
  customerEnquiryAckEmail,
  customerWaitlistEmail,
} = require('./_lib/resend.js');
const { getTenantEnv, getTenantEnvOptional } = require('./_lib/tenant.js');

module.exports = async function handler(req, res) {
  // CORS — the form is on bookitmalta.com hitting this same domain, so
  // technically we don't need CORS, but allow common cases for safety.
  res.setHeader('Access-Control-Allow-Origin', getAllowOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let tenant, config;
  try {
    ({ slug: tenant, config } = resolveTenant(req));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Parse form body (Vercel auto-parses application/x-www-form-urlencoded
  // and application/json on the Node runtime).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* leave as-is */ }
  }

  // Validate
  let input;
  try {
    input = validateEnquiry(body);
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }

  const supabase = getSupabase(tenant);
  const baseUrl = getTenantEnvOptional(tenant, 'PUBLIC_BASE_URL', 'https://bookitmalta.com');

  // ---- Step 1: is the preferred date already booked? ----
  const { data: dateTaken, error: rpcErr } = await supabase
    .rpc('is_date_taken', { p_date: input.preferred_date });

  if (rpcErr) {
    console.error('[enquiry] is_date_taken RPC error:', rpcErr);
    return res.status(500).json({ error: 'Database error' });
  }

  // ---- Step 2a: date is taken → waitlist path ----
  if (dateTaken) {
    return await routeToWaitlist({ supabase, tenant, config, input, baseUrl, req, res });
  }

  // ---- Step 2b: date is free → enquiry path ----
  return await routeToEnquiry({ supabase, tenant, config, input, baseUrl, req, res });
};

// =============================================================================
// ENQUIRY PATH — date is available
// =============================================================================
async function routeToEnquiry({ supabase, tenant, config, input, baseUrl, req, res }) {
  const audit = auditFields(req);

  // 1. Insert enquiry
  const { data: enquiry, error: insertErr } = await supabase
    .from('enquiries')
    .insert({
      ...input,
      charter_price_cents:  config.charterPriceCents,
      deposit_amount_cents: config.depositAmountCents,
      currency:             config.currency,
      source:               'web',
      user_agent:           audit.user_agent,
      referrer:             audit.referrer,
      ip_hash:              audit.ip_hash,
      terms_accepted_at:    new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr) {
    console.error('[enquiry] insert error:', insertErr);
    return res.status(500).json({ error: 'Could not save enquiry' });
  }

  // 2. Fire captain notification (best-effort — don't fail the request if email fails)
  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    const captainMsg = captainEnquiryEmail({ tenantConfig: config, enquiry, baseUrl });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: captainEmailAddr,
      subject: captainMsg.subject,
      text: captainMsg.text,
      replyTo: enquiry.customer_email,
    });
  } catch (e) {
    console.error('[enquiry] captain email failed:', e);
    // Continue — enquiry is saved, we'll catch this in logs and re-send manually
  }

  // 3. Fire customer ack
  try {
    const customerMsg = customerEnquiryAckEmail({ tenantConfig: config, enquiry });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: enquiry.customer_email,
      subject: customerMsg.subject,
      text: customerMsg.text,
    });
  } catch (e) {
    console.error('[enquiry] customer ack email failed:', e);
  }

  // 4. Redirect (form-style submit) or JSON response
  return respond(req, res, {
    type: 'enquiry',
    status: 'received',
    enquiry_id: enquiry.id,
    redirect: `${baseUrl}${config.publicPagePath}${config.confirmationAnchor}`,
    message: 'Enquiry received. Captain will be in touch within 24 hours.',
  });
}

// =============================================================================
// WAITLIST PATH — date is already booked
// =============================================================================
async function routeToWaitlist({ supabase, tenant, config, input, baseUrl, req, res }) {
  const audit = auditFields(req);

  // We still create an enquiry row to keep the history clean — but mark its
  // status so it doesn't sit in the captain's "received" queue.
  const { data: enquiry, error: enqErr } = await supabase
    .from('enquiries')
    .insert({
      ...input,
      charter_price_cents:  config.charterPriceCents,
      deposit_amount_cents: config.depositAmountCents,
      currency:             config.currency,
      status:               'cancelled',  // implicit: superseded by waitlist
      source:               'web',
      user_agent:           audit.user_agent,
      referrer:             audit.referrer,
      ip_hash:              audit.ip_hash,
      terms_accepted_at:    new Date().toISOString(),
      captain_note:         'Auto-routed to waitlist — date already booked.',
    })
    .select()
    .single();

  if (enqErr) {
    console.error('[waitlist] enquiry insert error:', enqErr);
    return res.status(500).json({ error: 'Could not save enquiry' });
  }

  // Get next position in queue
  const { data: position, error: posErr } = await supabase
    .rpc('next_waitlist_position', { p_date: input.preferred_date });

  if (posErr) {
    console.error('[waitlist] position RPC error:', posErr);
    return res.status(500).json({ error: 'Database error' });
  }

  // Insert waitlist entry
  const { data: waitlistEntry, error: wlErr } = await supabase
    .from('waitlist')
    .insert({
      enquiry_id:     enquiry.id,
      customer_name:  input.customer_name,
      customer_email: input.customer_email,
      customer_phone: input.customer_phone,
      requested_date: input.preferred_date,
      alt_dates:      input.alt_dates,
      party_size:     input.party_size,
      message:        input.message,
      tour_option:    input.tour_option,
      position,
    })
    .select()
    .single();

  if (wlErr) {
    console.error('[waitlist] insert error:', wlErr);
    return res.status(500).json({ error: 'Could not save to waitlist' });
  }

  // Notify customer
  try {
    const msg = customerWaitlistEmail({ tenantConfig: config, waitlistEntry });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: input.customer_email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[waitlist] customer email failed:', e);
  }

  // Notify captain (FYI — they don't need to act unless they want to)
  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: captainEmailAddr,
      subject: `[${config.name}] Waitlist — ${input.preferred_date} — ${input.customer_name} (pos ${position})`,
      text: `New waitlist entry — date is already booked.\n\nCustomer: ${input.customer_name} <${input.customer_email}>\nDate:     ${input.preferred_date}\nAlt:      ${input.alt_dates || '—'}\nParty:    ${input.party_size}\n\nIf you can offer the customer alternative dates yourself, reply to this email — they're cc'd via reply-to.\n\nBookItMalta`,
      replyTo: input.customer_email,
    });
  } catch (e) {
    console.error('[waitlist] captain email failed:', e);
  }

  return respond(req, res, {
    type: 'waitlist',
    status: 'waiting',
    enquiry_id: enquiry.id,
    waitlist_id: waitlistEntry.id,
    position,
    redirect: `${baseUrl}${config.publicPagePath}#waitlist-confirmed`,
    message: `Date is already booked. You're position ${position} on the waitlist.`,
  });
}

// =============================================================================
// helpers
// =============================================================================
function auditFields(req) {
  const ua = req.headers['user-agent'] || null;
  const ref = req.headers['referer'] || req.headers['referrer'] || null;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

  // Hash IP — we never store raw IP (GDPR-friendly)
  let ip_hash = null;
  if (ip) {
    try {
      const crypto = require('crypto');
      ip_hash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
    } catch { ip_hash = null; }
  }

  return { user_agent: ua, referrer: ref, ip_hash };
}

function getAllowOrigin(req) {
  const origin = req.headers.origin || '';
  const allowed = [
    'https://bookitmalta.com',
    'https://www.bookitmalta.com',
  ];
  if (allowed.includes(origin)) return origin;
  // Vercel preview origins are *.vercel.app — allow for testing
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
  return 'https://bookitmalta.com';
}

function respond(req, res, payload) {
  // If the request came from a normal HTML form (no JS), redirect.
  // If it came from fetch() (JSON), return JSON.
  const accept = req.headers.accept || '';
  const wantsJson = accept.includes('application/json') ||
                    (req.headers['content-type'] || '').includes('application/json');

  if (wantsJson) {
    return res.status(200).json(payload);
  }
  // 303 = "See Other" — switches POST to GET on redirect
  res.setHeader('Location', payload.redirect);
  return res.status(303).end();
}
