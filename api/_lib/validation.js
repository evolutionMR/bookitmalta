// api/_lib/validation.js
//
// Minimal input validation for the enquiry form.
// Keep it dependency-free — no Zod, no Joi. Vercel cold-start matters.
//
// Tenant-aware (2026-06-08): the `party_size` cap, the required-vs-optional
// `tour_option` semantics, and the allowed `tour_option` values all depend
// on the tenant config. validateEnquiry now takes (body, tenantConfig).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function v(value, label, fn) {
  const err = fn(value);
  if (err) throw new ValidationError(`${label}: ${err}`);
  return value;
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/**
 * Validate enquiry form body against tenant rules.
 *
 * @param {object} body
 * @param {object} [tenantConfig] — from config/tenants.js. Optional for
 *   backward compatibility: when omitted, falls back to legacy Bandama
 *   limits (party_size 1..20, tour_option optional + free-text).
 */
function validateEnquiry(body, tenantConfig) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Empty request body');
  }

  // Resolve tenant-specific limits with safe Bandama-era defaults.
  const maxPartySize = (tenantConfig && tenantConfig.defaultCapPerDeparture) || 20;
  const allowedSlots = (tenantConfig && tenantConfig.departureSlots) || null;
  const multiSlot =
    tenantConfig && tenantConfig.schedulingModel === 'multi_slot_per_day';

  const trim = (s) => (typeof s === 'string' ? s.trim() : s);

  const customer_name = v(trim(body.customer_name), 'customer_name', (x) =>
    !x ? 'required' :
    x.length < 2 ? 'too short' :
    x.length > 120 ? 'too long' :
    null
  );

  const customer_email = v(trim(body.customer_email)?.toLowerCase(), 'customer_email', (x) =>
    !x ? 'required' :
    !EMAIL_RE.test(x) ? 'invalid email format' :
    x.length > 240 ? 'too long' :
    null
  );

  const customer_phone = trim(body.customer_phone) || null;
  if (customer_phone && customer_phone.length > 40) {
    throw new ValidationError('customer_phone: too long');
  }

  const preferred_date = v(trim(body.preferred_date), 'preferred_date', (x) =>
    !x ? 'required' :
    !ISO_DATE_RE.test(x) ? 'must be YYYY-MM-DD' :
    isPast(x) ? 'cannot be in the past' :
    null
  );

  const party_size = v(parseInt(body.party_size, 10), 'party_size', (x) =>
    !Number.isFinite(x) ? 'required' :
    x < 1 ? 'must be at least 1' :
    x > maxPartySize ? `too large (max ${maxPartySize})` :
    null
  );

  const alt_dates = trim(body.alt_dates) || null;
  const message   = trim(body.message)   || null;

  // tour_option / slot_time: accept either field name from the form
  // (legacy bandama forms use tour_option; new AC form uses slot_time).
  // For multi-slot tenants, this becomes REQUIRED and must match
  // tenantConfig.departureSlots.
  let tour_option = trim(body.tour_option) || trim(body.slot_time) || null;
  if (multiSlot) {
    if (!tour_option) {
      throw new ValidationError('slot_time: required — pick a departure time');
    }
    if (allowedSlots && !allowedSlots.includes(tour_option)) {
      throw new ValidationError(
        `slot_time: must be one of ${allowedSlots.join(', ')}`
      );
    }
  }

  if (message && message.length > 4000) {
    throw new ValidationError('message: too long (max 4000 chars)');
  }
  if (alt_dates && alt_dates.length > 500) {
    throw new ValidationError('alt_dates: too long');
  }

  // Explicit terms acceptance (Phase 1.5b). Truthy values: true, "true",
  // "on", "1" — supports both JSON and form-encoded submissions.
  const ta = body.terms_accepted;
  const terms_accepted =
    ta === true || ta === 'true' || ta === 'on' || ta === '1' || ta === 1;
  if (!terms_accepted) {
    throw new ValidationError('terms_accepted: you must accept the Terms and Privacy Policy to continue');
  }

  const terms_version = v(trim(body.terms_version), 'terms_version', (x) =>
    !x ? 'required' :
    x.length > 40 ? 'too long' :
    null
  );

  return {
    customer_name,
    customer_email,
    customer_phone,
    preferred_date,
    alt_dates,
    party_size,
    message,
    tour_option,
    terms_version,
  };
}

function isPast(isoDate) {
  // Date-only comparison in UTC — close enough for our purposes
  const today = new Date().toISOString().slice(0, 10);
  return isoDate < today;
}

module.exports = { validateEnquiry, ValidationError };
