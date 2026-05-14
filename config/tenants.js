// config/tenants.js
//
// Tenant config lives in the repo (not env vars) so it's reviewable in PRs.
// Secrets (Supabase URL/key, Stripe keys, Resend key) live in tenant-namespaced
// env vars: BANDAMA_SUPABASE_URL, BANDAMA_STRIPE_SECRET_KEY, etc.
//
// To onboard a new tenant: add an entry here, add env vars in Vercel, run
// the SQL migration against the new Supabase project. No code changes.

const TENANTS = {
  bandama: {
    slug: 'bandama',
    name: 'Bandama Yacht Charters',
    operatorFirstName: 'Simon',
    boat: 'Beneteau Swift Trawler 47',

    // Pricing in cents (always)
    charterPriceCents: 185000,   // €1,850.00 — full day charter
    depositAmountCents: 30000,   // €300.00 — = our commission
    currency: 'EUR',

    // Policy
    cancellationWindowDays: 7,   // refund window before charter date
    confirmationExpiryHours: 48, // captain confirms → customer has 48h to pay
    waitlistOfferExpiryHours: 24,// waitlist slot opens → customer has 24h to claim

    // Routing
    publicPagePath: '/charters/bandama',
    confirmationAnchor: '#enquiry-confirmed',

    // Stripe Payment Link config
    stripeProductName: 'Bandama Charter — Deposit',
    stripeProductDescription: 'Non-refundable deposit for full-day charter aboard Beneteau Swift Trawler 47. Balance settled directly with captain on the day.',

    // Email branding
    emailFromName: 'Bandama Yacht Charters (via BookItMalta)',
    emailReplyTo: null,  // resolved from env var BANDAMA_OPERATOR_EMAIL

    // Single slot per day → calendar is just a date set
    schedulingModel: 'single_slot_per_day',
  },

  'adventure-cruises': {
    slug: 'adventure-cruises',
    name: 'Adventure Cruises',
    operatorFirstName: null,    // TBD when operator content received
    boat: 'TBC',

    charterPriceCents: 0,        // TBD
    depositAmountCents: 0,       // TBD
    currency: 'EUR',

    cancellationWindowDays: 7,
    confirmationExpiryHours: 48,
    waitlistOfferExpiryHours: 24,

    publicPagePath: '/charters/adventure-cruises',
    confirmationAnchor: '#enquiry-confirmed',

    stripeProductName: 'Adventure Cruises — Deposit',
    stripeProductDescription: 'Non-refundable deposit.',

    emailFromName: 'Adventure Cruises (via BookItMalta)',
    emailReplyTo: null,

    // Has multiple tours per day → set to true when we wire calendar
    schedulingModel: 'multi_slot_per_day',
  },
};

function getTenant(slug) {
  const tenant = TENANTS[slug];
  if (!tenant) {
    throw new Error(`Unknown tenant: ${slug}`);
  }
  return tenant;
}

function listTenants() {
  return Object.keys(TENANTS);
}

module.exports = { TENANTS, getTenant, listTenants };
