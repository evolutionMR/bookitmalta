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
const { computeBookingFee } = require('./_lib/stripe.js');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  let tenant, config;
  try {
    ({ slug: tenant, config } = resolveTenant(req));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // ---- GET ?mode=availability — server-side proxy for tenants whose
  // availability lives in an external system (Catamaran → Fleet Admin feed).
  // The upstream feed has no CORS headers, so the browser can't read it
  // directly; we fetch it server-side with a short cache. Read-only.
  if (req.method === 'GET') {
    if ((req.query && req.query.mode) === 'availability' && config.availabilityFeedUrl) {
      return await handleAvailabilityProxy({ config, res });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse form body (Vercel auto-parses application/x-www-form-urlencoded
  // and application/json on the Node runtime).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* leave as-is */ }
  }

  // ---- Private-charter QUOTE path -----------------------------------------
  // The quote button on the AC page posts { kind: 'private_charter' }. A quote
  // has no departure slot, no seat count and often no firm date, so it doesn't
  // fit the seat-booking validation or the (NOT NULL date/party) enquiries
  // table. We handle it separately: email the operator — who is BCC'd to the
  // BookItMalta owner via ADMIN_BCC_EMAIL — so a lead is captured reliably,
  // never depending on the visitor's own mail client (the old mailto problem).
  if (body && (body.kind === 'private_charter' || body.kind === 'quote')) {
    return await routeToQuote({ tenant, config, body, res });
  }

  // Validate against tenant-specific rules (party_size cap, slot list, etc.)
  let input;
  try {
    input = validateEnquiry(body, config);
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }

  const supabase = getSupabase(tenant);
  const baseUrl = getTenantEnvOptional(tenant, 'PUBLIC_BASE_URL', 'https://bookitmalta.com');

  // ---- Live-availability tenants (Catamaran): availability is checked
  // against the operator's external Fleet Admin feed + a boat-aware BIM-side
  // guard; price is snapshotted from the feed. Separate path — the 1-arg
  // is_date_taken RPC below doesn't exist in multi-boat schemas.
  if (config.pricingModel === 'percent_deposit') {
    return await routeToLiveAvailabilityEnquiry({ supabase, tenant, config, input, body, baseUrl, req, res });
  }

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

  // Compute the pricing snapshot for this enquiry. Bandama → flat charter
  // values from config. AC → party_size × per-seat fees. Multi-duration tenants
  // (Unexpected Charters) → the selected option's price. computeBookingFee
  // throws if the tenant config is malformed; fail loudly over wrong numbers.
  normalizeCharterOption(config, input);
  const fee = computeBookingFee(config, input.party_size, input.tour_option);
  const charterTotalCents = charterTotalCentsFor(config, input);

  // 1. Insert enquiry
  const { data: enquiry, error: insertErr } = await supabase
    .from('enquiries')
    .insert({
      ...input,
      charter_price_cents:  charterTotalCents,
      deposit_amount_cents: fee.totalCents,
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
// PRIVATE-CHARTER QUOTE PATH — no slot / seat / firm date
// =============================================================================
// Emails the operator (auto-BCC'd to ADMIN_BCC_EMAIL so BookItMalta stays in
// the loop) with the customer set as reply-to. No DB write — the enquiries
// table requires a date + party size a quote doesn't have, and this is a
// human-handled lead, not a seat booking. Returns JSON for the fetch() caller.
async function routeToQuote({ tenant, config, body, res }) {
  const trim = (s) => (typeof s === 'string' ? s.trim() : '');
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const name    = trim(body.customer_name);
  const email   = trim(body.customer_email).toLowerCase();
  const phone   = trim(body.customer_phone);
  const dates   = trim(body.preferred_dates || body.preferred_date);
  const group   = trim(String(body.party_size == null ? '' : body.party_size));
  const message = trim(body.message).slice(0, 4000);

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!EMAIL_RE.test(email) || email.length > 240) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }

  // Send to the operator if configured (this is what triggers the admin BCC);
  // otherwise straight to the platform admin so the lead is never dropped.
  const operatorEmail = getTenantEnvOptional(tenant, 'OPERATOR_EMAIL', null);
  const adminBcc = (process.env.ADMIN_BCC_EMAIL || '').trim() || null;
  const to = operatorEmail || adminBcc || 'hello@bookitmalta.com';

  const text = [
    `New PRIVATE CHARTER quote request — ${config.name}`,
    '',
    `Name:        ${name}`,
    `Email:       ${email}`,
    `Phone:       ${phone || '—'}`,
    `Preferred:   ${dates || '—'}`,
    `Group size:  ${group || '—'}`,
    '',
    'Message:',
    message || '—',
    '',
    'Reply to this email to reach the customer directly (set as reply-to).',
    '',
    'BookItMalta',
  ].join('\n');

  try {
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to,
      subject: `[${config.name}] Private charter quote — ${name}`,
      text,
      replyTo: email,
    });
  } catch (e) {
    console.error('[quote] email failed:', e);
    return res.status(502).json({ error: 'Could not send your request right now.' });
  }

  return res.status(200).json({ type: 'quote', status: 'sent' });
}

// =============================================================================
// WAITLIST PATH — date is already booked
// =============================================================================
async function routeToWaitlist({ supabase, tenant, config, input, baseUrl, req, res }) {
  const audit = auditFields(req);

  // Pricing snapshot — same as the enquiry path (per-seat / multi-duration aware).
  normalizeCharterOption(config, input);
  const fee = computeBookingFee(config, input.party_size, input.tour_option);
  const charterTotalCents = charterTotalCentsFor(config, input);

  // We still create an enquiry row to keep the history clean — but mark its
  // status so it doesn't sit in the captain's "received" queue.
  const { data: enquiry, error: enqErr } = await supabase
    .from('enquiries')
    .insert({
      ...input,
      charter_price_cents:  charterTotalCents,
      deposit_amount_cents: fee.totalCents,
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
// LIVE-AVAILABILITY TENANTS (Catamaran) — external Fleet Admin integration
// =============================================================================
// BookItMalta NEVER writes to the operator's booking engine. It only:
//   1. reads the public availability feed (proxied below for CORS), and
//   2. posts an anonymised enquiry via the same track-enquiry endpoint the
//      operator's own website uses (no customer PII — contact is
//      hello@bookitmalta.com), storing the returned ref for reconciliation.

let _availCache = { t: 0, data: null, url: null };

async function fetchAvailabilityFeed(config) {
  const now = Date.now();
  if (_availCache.data && _availCache.url === config.availabilityFeedUrl && now - _availCache.t < 60000) {
    return _availCache.data;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(config.availabilityFeedUrl, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
    const data = await r.json();
    _availCache = { t: now, data, url: config.availabilityFeedUrl };
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function handleAvailabilityProxy({ config, res }) {
  try {
    const data = await fetchAvailabilityFeed(config);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      boats:        data.boats || [],
      experiences:  data.experiences || [],
      availability: data.availability || [],
    });
  } catch (e) {
    console.error('[enquiry] availability proxy failed:', e.message || e);
    return res.status(502).json({ error: 'Availability is temporarily unavailable.' });
  }
}

// Resolve the charter price (cents) for boat × experience × date from the
// feed's experience entry: month in priceShoulderMonths → priceShoulder,
// otherwise priceRegular. Prices in the feed are whole EUR.
function priceCentsForDate(expEntry, isoDate) {
  const month = Number(String(isoDate).slice(5, 7));
  const shoulder = Array.isArray(expEntry.priceShoulderMonths) && expEntry.priceShoulderMonths.includes(month);
  const eur = shoulder && expEntry.priceShoulder ? expEntry.priceShoulder : expEntry.priceRegular;
  if (!eur || eur <= 0) return null;
  return Math.round(eur * 100);
}

// A boat×date×experience is unavailable if the feed shows ANY confirmed
// reservation on it (whole-boat private charters — one booking takes the day
// for that experience).
function isTakenInFeed(feed, boatSlug, isoDate, experienceId) {
  const boatEntry = (feed.availability || []).find((b) => b.boatId === boatSlug);
  if (!boatEntry) return false;
  const day = (boatEntry.dates || []).find((d) => d.date === isoDate);
  if (!day) return false;
  const dayConfirmed = (day.reservations || []).some((r) => r.status === 'confirmed');
  const exp = (day.experiences || []).find((e) => e.experienceId === experienceId);
  const expConfirmed = exp ? (exp.reservations || []).some((r) => r.status === 'confirmed') : false;
  // Day-level confirmed reservations with no experience breakdown block the
  // whole day; otherwise only the matching experience blocks.
  return expConfirmed || (dayConfirmed && !(day.experiences || []).length);
}

async function routeToLiveAvailabilityEnquiry({ supabase, tenant, config, input, body, baseUrl, req, res }) {
  const audit = auditFields(req);
  const trim = (s) => (typeof s === 'string' ? s.trim() : '');

  // 1. Boat — must be one of the tenant's fleet; party must fit the boat.
  const boatSlug = trim(body && body.boat_slug);
  const boat = config.boats && config.boats[boatSlug];
  if (!boat) {
    return res.status(400).json({ error: 'Please pick a boat.' });
  }
  if (input.party_size > boat.capacity) {
    return res.status(400).json({ error: `${boat.name} takes up to ${boat.capacity} guests.` });
  }

  // 2. Feed — experience must exist, be offered on this boat, and the combo
  //    must be free. The feed is also the price source (snapshotted).
  let feed;
  try {
    feed = await fetchAvailabilityFeed(config);
  } catch (e) {
    console.error('[enquiry] catamaran feed unavailable:', e.message || e);
    return res.status(502).json({ error: 'Live availability is temporarily unavailable — please try again in a minute.' });
  }
  const expEntry = (feed.experiences || []).find((x) => x.id === input.tour_option);
  if (!expEntry) {
    return res.status(400).json({ error: 'Please pick an experience.' });
  }
  if (Array.isArray(expEntry.boats) && !expEntry.boats.includes(boatSlug)) {
    return res.status(400).json({ error: `${expEntry.name} is not offered on ${boat.name}.` });
  }
  const priceCents = priceCentsForDate(expEntry, input.preferred_date);
  if (!priceCents) {
    console.error('[enquiry] catamaran price missing for', input.tour_option, input.preferred_date);
    return res.status(502).json({ error: 'Pricing is temporarily unavailable — please try again in a minute.' });
  }

  // 3. Availability — external feed + BIM-side boat-aware duplicate guard.
  if (isTakenInFeed(feed, boatSlug, input.preferred_date, input.tour_option)) {
    return res.status(200).json({
      type: 'enquiry', status: 'date_taken',
      message: 'That date has just been taken for this boat — pick another date and we\'ll get you on the water.',
    });
  }
  const { data: bimTaken, error: rpcErr } = await supabase
    .rpc('is_date_taken', { p_date: input.preferred_date, p_boat_slug: boatSlug, p_tour: input.tour_option });
  if (rpcErr) {
    console.error('[enquiry] catamaran is_date_taken RPC error:', rpcErr);
    return res.status(500).json({ error: 'Database error' });
  }
  if (bimTaken) {
    return res.status(200).json({
      type: 'enquiry', status: 'date_taken',
      message: 'That date has just been taken for this boat — pick another date and we\'ll get you on the water.',
    });
  }

  // 4. Insert the enquiry — price snapshotted so a seasonal price change can
  //    never shift an in-flight deposit. Deposit math via percent_deposit.
  const fee = computeBookingFee(config, input.party_size, input.tour_option, priceCents);
  const { data: enquiry, error: insertErr } = await supabase
    .from('enquiries')
    .insert({
      ...input,
      boat_slug:            boatSlug,
      charter_price_cents:  priceCents,
      deposit_amount_cents: fee.totalCents,
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
    console.error('[enquiry] catamaran insert error:', insertErr);
    return res.status(500).json({ error: 'Could not save enquiry' });
  }

  // 5. Relay an ANONYMISED enquiry into the operator's Fleet Admin via the
  //    same endpoint their own site uses. No customer PII — contact email is
  //    the platform's. Best-effort: a relay failure never loses the lead
  //    (it's already saved on BIM and emailed to the operator contact).
  try {
    const ref = String(enquiry.id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const relayRes = await fetch(config.enquiryRelayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        boat_slug:     boatSlug,
        experience_id: input.tour_option,
        date:          input.preferred_date,
        guests:        input.party_size,
        email:         config.relayEnquiryEmail,
        wa_message:    `BookItMalta booking — ref BIM-${ref}. ${input.party_size} guests. Customer details held by BookItMalta (hello@bookitmalta.com).`,
        utm_source:    config.relayUtmSource || 'bookitmalta',
        utm_medium:    'platform',
        utm_campaign:  'bim-booking',
        referrer:      'https://bookitmalta.com/catamaran',
        landing_page:  '/catamaran',
      }),
    }).finally(() => clearTimeout(timer));
    let relayJson = null;
    try { relayJson = await relayRes.json(); } catch { /* non-JSON */ }
    const fleetRef = relayJson && (relayJson.booking_code || relayJson.bookingCode || relayJson.code);
    if (fleetRef) {
      await supabase.from('enquiries').update({ fleet_admin_ref: String(fleetRef) }).eq('id', enquiry.id);
      enquiry.fleet_admin_ref = String(fleetRef);
    } else {
      console.warn('[enquiry] catamaran relay returned no booking_code', relayRes && relayRes.status);
    }
  } catch (e) {
    console.error('[enquiry] catamaran relay failed (non-fatal):', e.message || e);
  }

  // 6. Notify the BIM operator contact + customer ack (existing templates).
  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    const captainMsg = captainEnquiryEmail({ tenantConfig: config, enquiry, baseUrl });
    await sendEmail({
      tenantSlug: tenant, tenantConfig: config, to: captainEmailAddr,
      subject: captainMsg.subject, text: captainMsg.text, replyTo: enquiry.customer_email,
    });
  } catch (e) { console.error('[enquiry] catamaran captain email failed:', e); }
  try {
    const customerMsg = customerEnquiryAckEmail({ tenantConfig: config, enquiry });
    await sendEmail({
      tenantSlug: tenant, tenantConfig: config, to: enquiry.customer_email,
      subject: customerMsg.subject, text: customerMsg.text,
    });
  } catch (e) { console.error('[enquiry] catamaran customer ack failed:', e); }

  return respond(req, res, {
    type: 'enquiry',
    status: 'received',
    enquiry_id: enquiry.id,
    deposit_cents: fee.totalCents,
    charter_price_cents: priceCents,
    redirect: `${baseUrl}${config.publicPagePath}${config.confirmationAnchor}`,
    message: 'Request received. We\'ll confirm availability within 24 hours, then send a secure deposit link to lock your date.',
  });
}

// =============================================================================
// helpers
// =============================================================================
// For multi-duration flat_charter tenants (charterOptions), force tour_option
// to a valid key so the stored value + pricing are always one of the configured
// durations. No-op for single-price tenants (Bandama) and per-seat (AC).
function normalizeCharterOption(config, input) {
  if (config.pricingModel === 'flat_charter' && config.charterOptions) {
    if (!(input.tour_option && config.charterOptions[input.tour_option])) {
      input.tour_option = config.defaultCharterOption;
    }
  }
}

// Resolve the full charter value (what the booking is worth) for the snapshot.
function charterTotalCentsFor(config, input) {
  if (config.pricingModel === 'per_seat') {
    return (config.pricePerSeatCents || 0) * input.party_size;
  }
  if (config.charterOptions) {
    const key = (input.tour_option && config.charterOptions[input.tour_option])
      ? input.tour_option
      : config.defaultCharterOption;
    const opt = config.charterOptions[key];
    if (opt && opt.charterPriceCents) return opt.charterPriceCents;
  }
  return config.charterPriceCents;
}

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
