// api/operator-intake.js
//
// Receives the operator onboarding intake form (POST JSON from
// /for-operators/intake) and emails the submission to the BookItMalta admin
// inbox. Additive: no Supabase, no Stripe, no tenant — it only sends an email.
//
// Destination resolves from env (first non-empty wins):
//   OPERATOR_INTAKE_TO  → ADMIN_BCC_EMAIL  → hello@bookitmalta.com
// Reply-To is set to the operator's email so you can reply to them directly.

const { sendEmail } = require('./_lib/resend.js');

// [field key, human label] — order defines the email layout.
const FIELDS = [
  ['biz_name', 'Business name'],
  ['contact_name', 'Contact name'],
  ['contact_role', 'Role'],
  ['email', 'Email'],
  ['phone', 'Phone / WhatsApp'],
  ['website', 'Website'],
  ['social', 'Social'],
  ['vat', 'Company / VAT no.'],
  ['boat_name', 'Boat name(s)'],
  ['boat_model', 'Make / model'],
  ['boat_year', 'Year / refit'],
  ['capacity', 'Max guests per trip'],
  ['boat_count', 'Number of boats'],
  ['boat_features', 'Boat features'],
  ['exp_name', 'Experience name'],
  ['exp_desc', 'Description'],
  ['exp_route', 'Route / itinerary'],
  ['duration', 'Duration'],
  ['languages', 'Languages'],
  ['included', 'Included'],
  ['not_included', 'Not included'],
  ['sched', 'Departures'],
  ['times', 'Departure time(s)'],
  ['days', 'Days operating'],
  ['season', 'Season'],
  ['pricing_model', 'Sells by'],
  ['charter_price', 'Whole-boat price'],
  ['seat_price', 'Price per seat'],
  ['seat_child', 'Child / group pricing'],
  ['deposit', 'Deposit'],
  ['balance', 'Paid on the day'],
  ['meeting_point', 'Meeting point'],
  ['boarding_notes', 'Boarding notes'],
  ['cancellation', 'Cancellation policy'],
  ['min_guests', 'Minimum numbers'],
  ['weather', 'Weather policy'],
  ['photo_link', 'Photos link'],
  ['brand', 'Brand / logo'],
  ['notes', 'Other notes'],
];

function clean(v) {
  return String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, 4000);
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  body = body || {};

  // Honeypot — bots fill hidden fields, humans don't. Pretend success so the
  // bot doesn't retry, but send nothing.
  if (clean(body.company_hp)) return res.status(200).json({ ok: true });

  const biz = clean(body.biz_name);
  const name = clean(body.contact_name);
  const email = clean(body.email);

  if (!biz || !name || !email) {
    return res.status(400).json({ error: 'Please include at least your business name, your name, and an email.' });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'That email address looks invalid — please check it.' });
  }

  const lines = ['New operator listing enquiry — bookitmalta.com', '='.repeat(46), ''];
  for (const [key, label] of FIELDS) {
    const val = clean(body[key]);
    if (val) lines.push(`${label}: ${val}`);
  }
  lines.push('', 'Reply to this email to reach the operator directly.', '— sent automatically from /for-operators/intake');
  const text = lines.join('\n');

  const to = (process.env.OPERATOR_INTAKE_TO || process.env.ADMIN_BCC_EMAIL || 'hello@bookitmalta.com').trim();

  try {
    // tenantSlug:'platform' avoids the tenant env lookup throwing on an
    // undefined slug; RESEND_FROM falls back to the default BookItMalta sender.
    await sendEmail({
      tenantSlug: 'platform',
      to,
      subject: `New operator listing — ${biz}`,
      text,
      replyTo: email,
    });
  } catch (err) {
    console.error('[operator-intake] send failed:', err && err.message ? err.message : err);
    return res.status(502).json({ error: 'We could not send your details just now. Please email hello@bookitmalta.com directly.' });
  }

  return res.status(200).json({ ok: true });
};
