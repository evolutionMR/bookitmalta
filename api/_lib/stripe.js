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
 * Create a Stripe Payment Link for an enquiry deposit.
 *
 * @param {Object} args
 * @param {string} args.tenantSlug
 * @param {Object} args.tenantConfig — from config/tenants.js
 * @param {Object} args.enquiry — row from `enquiries` table
 * @param {string} args.successUrl — where Stripe redirects after payment
 * @returns {Promise<{id: string, url: string, expiresAt: Date}>}
 */
async function createDepositPaymentLink({ tenantSlug, tenantConfig, enquiry, successUrl }) {
  const stripe = getStripe(tenantSlug);

  // 1. Create the Product (idempotent via tenant slug — reuse if exists)
  //    Simpler: create on the fly each time. Cheap.
  const product = await stripe.products.create({
    name: tenantConfig.stripeProductName,
    description: tenantConfig.stripeProductDescription,
    metadata: {
      tenant: tenantSlug,
      product_type: 'charter_deposit',
    },
  });

  // 2. Create the Price (one-off, deposit amount)
  const price = await stripe.prices.create({
    product:     product.id,
    currency:    tenantConfig.currency.toLowerCase(),
    unit_amount: tenantConfig.depositAmountCents,
  });

  // 3. Create the Payment Link
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: successUrl },
    },
    metadata: {
      tenant:     tenantSlug,
      enquiry_id: enquiry.id,
      customer_email: enquiry.customer_email,
      charter_date:   enquiry.preferred_date,
      party_size:     String(enquiry.party_size),
    },
    // Pre-fill customer email — Stripe doesn't allow direct email in
    // payment_links, but we can set restrictions and prefilled_customer
    // via the customer_creation flag.
    customer_creation: 'always',
    // Don't allow promotion codes — we're not running promos
    allow_promotion_codes: false,
  });

  // Payment links don't have a hard expiry, but we track our own logical
  // expiry window (config.confirmationExpiryHours) and ignore late payments.
  const expiresAt = new Date(
    Date.now() + tenantConfig.confirmationExpiryHours * 60 * 60 * 1000
  );

  return {
    id:        link.id,
    url:       link.url,
    expiresAt,
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
};
