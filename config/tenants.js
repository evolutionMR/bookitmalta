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

    // Postgres schema in the shared Supabase project (see
    // feedback_isolated_tenant_supabase_from_day_one for the stage-aware
    // isolation policy). Bandama lives in `public` since it predates the
    // schema-isolation split.
    schema: 'public',

    // Pricing in cents (always)
    charterPriceCents: 185000,   // €1,850.00 — full day charter
    depositAmountCents: 30000,   // €300.00 — = our commission
    currency: 'EUR',

    // Pricing model — Bandama sells the whole boat for a fixed price.
    pricingModel: 'flat_charter',

    // Policy
    cancellationWindowDays: 7,   // refund window before charter date
    confirmationExpiryHours: 48, // captain confirms → customer has 48h to pay
    waitlistOfferExpiryHours: 24,// waitlist slot opens → customer has 24h to claim

    // Routing
    publicPagePath: '/charters/bandama',
    confirmationAnchor: '#enquiry-confirmed',

    // Stripe Payment Link config
    stripeProductName: 'BookItMalta booking fee — Bandama charter',
    stripeProductDescription: 'Booking fee charged by BookItMalta to secure your date for a full-day charter aboard Beneteau Swift Trawler 47. The charter price is paid directly to Bandama Yacht Charters on the day, as a separate transaction.',

    // Email branding
    emailFromName: 'Bandama Yacht Charters (via BookItMalta)',
    emailReplyTo: null,  // resolved from env var BANDAMA_OPERATOR_EMAIL

    // Single slot per day → calendar is just a date set
    schedulingModel: 'single_slot_per_day',

    // Calendar event fields — used by /booking-confirmed page + customer
    // booking-confirmed email (.ics attachment + Add-to-Calendar links).
    experienceDurationHours: 8,
    defaultStartTime: '09:00',                     // 24h Malta local
    meetingPointAddress: "Ta' Xbiex Creek Marina, Ta' Xbiex, Malta",
    calendarEventTitle: 'Bandama — Private Day Charter',
    captainAllowlist: [
      'catamaranmaltacharters@gmail.com',          // Simon (operator)
      'true-northdigital@outlook.com',             // Julian (owner)
    ],
  },

  'adventure-cruises': {
    slug: 'adventure-cruises',
    name: 'Adventure Cruises',
    operatorFirstName: 'Tony',                    // Anthony Farrugia
    boat: 'Albert V + Adventure 1 (40 seats each)',

    // Lives in its own Postgres schema inside the shared Supabase project.
    schema: 'adventure_cruises',

    // Pricing — per-seat model, not flat-charter. The engine reads the
    // pricingModel field to know which math to apply. Per-seat fields are
    // the source of truth for AC; charterPriceCents/depositAmountCents are
    // kept as 0 to make any "Bandama-style" math fail loudly if accidentally
    // triggered for this tenant.
    pricingModel: 'per_seat',
    pricePerSeatCents: 4000,                       // €40.00 per seat
    bookingFeePerSeatCents: 1000,                  // €10.00 per seat to BookItMalta
    balancePerSeatCents: 3000,                     // €30.00 per seat collected on-boat by crew
    charterPriceCents: 0,                          // unused — see pricingModel
    depositAmountCents: 0,                         // unused — see pricingModel
    currency: 'EUR',

    // Departure capacity — 2 boats × 40 seats default.
    defaultCapPerDeparture: 80,
    fleetBoats: ['albert_v', 'adventure_1'],
    departureSlots: ['09:30', '14:30'],

    // Policy
    cancellationWindowDays: 1,                     // 24h cancellation
    confirmationExpiryHours: 24,
    waitlistOfferExpiryHours: 12,

    // Routing
    publicPagePath: '/adventure-cruises',
    confirmationAnchor: '#enquiry-confirmed',

    // Stripe Payment Link config
    stripeProductName: 'BookItMalta booking fee — Adventure Cruises day tour',
    stripeProductDescription: 'Booking fee charged by BookItMalta to secure your seats on a shared day tour to Comino, the Blue Lagoon and Gozo. The remaining balance (€30 per seat) is paid to the crew on the day, as a separate transaction.',

    emailFromName: 'Adventure Cruises (via BookItMalta)',
    emailReplyTo: null,                            // resolved from ADVENTURE_CRUISES_OPERATOR_EMAIL

    // Multiple slots per day — calendar is (date × slot)
    schedulingModel: 'multi_slot_per_day',

    // Calendar event fields — start time pulled from booking.tour_option
    // (09:30 or 14:30 Malta local). 5-hour shared day tour.
    experienceDurationHours: 5,
    // No defaultStartTime — start time comes from booking.tour_option
    meetingPointAddress: 'Sliema Ferries, Sliema, Malta',
    calendarEventTitle: 'Adventure Cruises — Day Tour to Comino',
    captainAllowlist: [
      'farrugia34@hotmail.com',                    // Tony (operator)
      'true-northdigital@outlook.com',             // Julian (owner)
    ],
  },

  // Quote-only listing — no Supabase schema, no Stripe, no DB writes. Catamaran
  // (La Zingara + Chardonnay) is operated by Simon (same operator as Bandama).
  // Enquiries are captured via the /api/enquiry quote path (kind:'private_charter')
  // which only emails — it never touches the booking tables. Set the optional
  // env var CATAMARAN_OPERATOR_EMAIL to route quote emails to the operator
  // (auto-BCC'd to ADMIN_BCC_EMAIL); if unset, they fall back to the platform
  // admin / hello@bookitmalta.com so a lead is never dropped.
  catamaran: {
    slug: 'catamaran',
    name: 'Catamaran Malta — La Zingara & Chardonnay',
    operatorFirstName: 'Simon',
    boat: 'La Zingara (Lagoon 450) + Chardonnay (Lagoon 440)',
    pricingModel: 'quote',          // quote-only: never hits stripe/supabase math
    currency: 'EUR',
    publicPagePath: '/catamaran',
    confirmationAnchor: '#enquiry-confirmed',
    emailFromName: 'Catamaran Malta (via BookItMalta)',
    emailReplyTo: null,             // resolved from CATAMARAN_OPERATOR_EMAIL if set
    schedulingModel: 'quote',
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
