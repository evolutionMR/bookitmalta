// api/_lib/stripe.js
//
// Per-tenant Stripe client + Payment Link creation helper.
//
// For Hosted Founding tenants (Bandama et al.), the deposit IS our
// commission — so the Payment Link points to BookItMalta's Stripe account.
// The operator collects the balance off-platform.
//
// When we onboard tenants who want deposits routed to their own Stripe
// account, we'll switch to Stripe Connect Standard + application_fee_amount
// (separate code path, not built here).

const Stripe = require('stripe');
const { getTenantEnv } = require('./tenant.js');

const clientCache = new Map();

function getStripe(tenantSlug) {
  if (clientCache.has(tenantSlug)) {
    return clientCache.get(tenantSlug);
  }
  const key = getTenantEnv(tenantSlug, 'STRIPE_SECRET_KEY');
  const client = new Stripe(key, { apiVersion: '2024-06-20' });
  clientCache.set(tenantSlug, client);
  return client;
}

/**
 * Compute the booking-fee math for an enquiry. Returns the Stripe line-item
 * shape (unit_amount + quantity) plus a human-readable amount summary for
 * the Payment Link product description.
 *
 * Three pricing models supported:
 *   • 'flat_charter' (Bandama-style) — fixed deposit per booking, quantity 1
 *   • 'per_seat' (Adventure Cruises-style) — per-seat fee × party_size
 *   • 'percent_deposit' (Catamaran-style) — depositPercent × the charter price
 *     snapshotted on the enquiry (charter_price_cents), quantity 1
 *
 * Throws if the tenant's pricingModel is missing or unknown — money math
 * should fail loudly rather than silently default to a wrong value.
 */
function computeBookingFee(tenantConfig, partySize, chosenOption, priceCents) {
  const model = tenantConfig.pricingModel;
  if (!model) {
    throw new Error(
      `Tenant "${tenantConfig.slug}" is missing pricingModel. ` +
      `Add 'flat_charter' or 'per_seat' to config/tenants.js.`
    );
  }

  if (model === 'flat_charter') {
    // Multi-duration tenants (e.g. Unexpected Charters: full / half day) declare
    // a `charterOptions` map; the deposit comes from the selected option. Tenants
    // without it (Bandama) keep using the single depositAmountCents — unchanged.
    let unitAmount = tenantConfig.depositAmountCents;
    let optionLabel = '';
    if (tenantConfig.charterOptions) {
      const key = (chosenOption && tenantConfig.charterOptions[chosenOption])
        ? chosenOption
        : tenantConfig.defaultCharterOption;
      const opt = key ? tenantConfig.charterOptions[key] : null;
      if (!opt || !opt.depositAmountCents) {
        throw new Error(
          `Tenant "${tenantConfig.slug}" charterOptions misconfigured for option "${key}"`
        );
      }
      unitAmount = opt.depositAmountCents;
      optionLabel = opt.label ? ` (${opt.label})` : '';
    }
    if (!unitAmount || unitAmount <= 0) {
      throw new Error(
        `Tenant "${tenantConfig.slug}" pricingModel=flat_charter but ` +
        `depositAmountCents is ${unitAmount}`
      );
    }
    return {
      unitAmountCents: unitAmount,
      quantity:        1,
      totalCents:      unitAmount,
      summary: formatMoney(unitAmount, tenantConfig.currency)
        + ' booking fee' + optionLabel,
    };
  }

  if (model === 'per_seat') {
    const perSeat = tenantConfig.bookingFeePerSeatCents;
    if (!perSeat || perSeat <= 0) {
      throw new Error(
        `Tenant "${tenantConfig.slug}" pricingModel=per_seat but ` +
        `bookingFeePerSeatCents is ${perSeat}`
      );
    }
    const seats = Number.isInteger(partySize) && partySize > 0
      ? partySize
      : null;
    if (!seats) {
      throw new Error(
        `per_seat pricing requires a positive integer partySize, got ${partySize}`
      );
    }
    const total = perSeat * seats;
    return {
      unitAmountCents: perSeat,
      quantity:        seats,
      totalCents:      total,
      summary: `${seats} × ${formatMoney(perSeat, tenantConfig.currency)}`
        + ` = ${formatMoney(total, tenantConfig.currency)} booking fee`,
    };
  }

  if (model === 'percent_deposit') {
    // Deposit = depositPercent × the charter price snapshotted on the enquiry
    // at submission time (charter_price_cents). The price is snapshotted so a
    // seasonal price change can never shift an in-flight deposit.
    const pct = tenantConfig.depositPercent;
    if (!pct || pct <= 0 || pct >= 1) {
      throw new Error(
        `Tenant "${tenantConfig.slug}" pricingModel=percent_deposit but ` +
        `depositPercent is ${pct} (expected 0 < pct < 1, e.g. 0.20)`
      );
    }
    const price = Number(priceCents);
    if (!Number.isInteger(price) || price <= 0) {
      throw new Error(
        `percent_deposit pricing requires the enquiry's charter_price_cents, got ${priceCents}`
      );
    }
    const unit = Math.round(pct * price);
    return {
      unitAmountCents: unit,
      quantity:        1,
      totalCents:      unit,
      summary: `${Math.round(pct * 100)}% deposit — `
        + `${formatMoney(unit, tenantConfig.currency)} of `
        + `${formatMoney(price, tenantConfig.currency)} charter price`,
    };
  }

  throw new Error(
    `Unknown pricingModel "${model}" for tenant "${tenantConfig.slug}"`
  );
}

/**
 * Render a cents-int as a localised money string (e.g. 4000 EUR → "€40.00").
 * Minimal — only handles EUR/USD/GBP currency symbols. Anything else falls
 * back to the ISO code.
 */
function formatMoney(cents, currency) {
  const amount = (cents / 100).toFixed(2);
  switch (String(currency || '').toUpperCase()) {
    case 'EUR': return `€${amount}`;
    case 'USD': return `$${amount}`;
    case 'GBP': return `£${amount}`;
    default:    return `${amount} ${currency}`;
  }
}

/**
 * Create a Stripe Payment Link for an enquiry deposit / booking fee.
 *
 * @param {Object} args
 * @param {string} args.tenantSlug
 * @param {Object} args.tenantConfig — from config/tenants.js
 * @param {Object} args.enquiry — row from `enquiries` table
 * @param {string} args.successUrl — where Stripe redirects after payment
 * @returns {Promise<{id: string, url: string, expiresAt: Date, totalCents: number}>}
 */
async function createDepositPaymentLink({ tenantSlug, tenantConfig, enquiry, successUrl }) {
  const stripe = getStripe(tenantSlug);

  // 1. Resolve the per-tenant pricing math (flat charter or per seat).
  //    For multi-duration tenants the deposit follows the enquiry's chosen
  //    option (full / half day). This throws if config is malformed.
  const fee = computeBookingFee(
    tenantConfig,
    enquiry.party_size,
    enquiry.tour_option,
    enquiry.charter_price_cents   // used by percent_deposit only; ignored otherwise
  );

  // 2. Build a product description that includes the seat-math for per_seat
  //    tenants. Customers see "4 × €10 = €40 booking fee" in Stripe checkout.
  const description = tenantConfig.pricingModel === 'per_seat'
    ? `${tenantConfig.stripeProductDescription} — ${fee.summary}`
    : tenantConfig.stripeProductDescription;

  // 3. Create the Product (created fresh each enquiry — cheap, no idempotency
  //    needed because customers see only the latest link).
  const product = await stripe.products.create({
    name: tenantConfig.stripeProductName,
    description,
    metadata: {
      tenant:        tenantSlug,
      product_type:  'charter_deposit',
      pricing_model: tenantConfig.pricingModel,
      party_size:    String(enquiry.party_size),
    },
  });

  // 4. Create the Price — unit_amount × quantity = total. Stripe shows the
  //    customer the multiplication inline at checkout.
  const price = await stripe.prices.create({
    product:     product.id,
    currency:    tenantConfig.currency.toLowerCase(),
    unit_amount: fee.unitAmountCents,
  });

  // 5. Create the Payment Link.
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: fee.quantity }],
    after_completion: {
      type: 'redirect',
      redirect: { url: successUrl },
    },
    metadata: {
      tenant:           tenantSlug,
      enquiry_id:       enquiry.id,
      customer_email:   enquiry.customer_email,
      charter_date:     enquiry.preferred_date,
      party_size:       String(enquiry.party_size),
      pricing_model:    tenantConfig.pricingModel,
      unit_amount_cents: String(fee.unitAmountCents),
      total_cents:      String(fee.totalCents),
    },
    customer_creation: 'always',
    allow_promotion_codes: false,
  });

  // Payment links don't have a hard expiry, but we track our own logical
  // expiry window (config.confirmationExpiryHours) and ignore late payments.
  const expiresAt = new Date(
    Date.now() + tenantConfig.confirmationExpiryHours * 60 * 60 * 1000
  );

  return {
    id:         link.id,
    url:        link.url,
    expiresAt,
    totalCents: fee.totalCents,
  };
}

/**
 * Deactivate a Payment Link (after payment, decline, or expiry).
 */
async function deactivatePaymentLink(tenantSlug, paymentLinkId) {
  const stripe = getStripe(tenantSlug);
  return stripe.paymentLinks.update(paymentLinkId, { active: false });
}

/**
 * Verify a Stripe webhook signature.
 *
 * @param {string} tenantSlug
 * @param {string|Buffer} rawBody — raw request body (NOT JSON-parsed)
 * @param {string} signature — value of Stripe-Signature header
 * @returns {Stripe.Event}
 */
function verifyWebhook(tenantSlug, rawBody, signature) {
  const stripe = getStripe(tenantSlug);
  const webhookSecret = getTenantEnv(tenantSlug, 'STRIPE_WEBHOOK_SECRET');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

module.exports = {
  getStripe,
  createDepositPaymentLink,
  deactivatePaymentLink,
  verifyWebhook,
  computeBookingFee,   // exported for unit tests + captain.js display
  formatMoney,
};
