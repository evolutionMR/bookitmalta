// api/_lib/pricing.js
//
// One place that decides WHICH charter option (e.g. full day / half day) an
// enquiry is priced on. Used by the card payment link (stripe.js), the stored
// price snapshot (enquiry.js) and the email templates (resend.js), so the
// figure in an email is always the figure the card page charges.
//
// No prices live here — they stay in tenants.config.js. No SDK imports, so it
// is safe to require from anywhere.

/**
 * Resolve the charter option for a tenant that declares `charterOptions`.
 *
 * @param {Object} tenantConfig — from api/_lib/tenants.config.js
 * @param {string|null|undefined} chosenOption — usually enquiry.tour_option
 * @returns {{ key: string|undefined, option: Object|null }|null}
 *   null when the tenant has no `charterOptions` (single-price and per-seat
 *   tenants). Otherwise the chosen option if it is a configured key, else the
 *   tenant's `defaultCharterOption`.
 */
function resolveCharterOption(tenantConfig, chosenOption) {
  if (!tenantConfig || !tenantConfig.charterOptions) return null;
  const key = (chosenOption && tenantConfig.charterOptions[chosenOption])
    ? chosenOption
    : tenantConfig.defaultCharterOption;
  const option = key ? tenantConfig.charterOptions[key] : null;
  return { key, option: option || null };
}

module.exports = { resolveCharterOption };
