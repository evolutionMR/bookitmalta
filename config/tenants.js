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

  // Catamaran Malta — PROMOTED from quote-only to full booking tenant.
  // Multi-boat (La Zingara + Chardonnay), two experiences, availability read
  // live from the operator's own Fleet Admin system (catamaranmalta.com) —
  // BookItMalta NEVER writes to that system's booking engine; it only reads
  // the public availability feed and posts an anonymised enquiry (no customer
  // PII) via track-enquiry, storing the returned TND ref for reconciliation.
  //
  // Deposit model: percent_deposit — customer pays 20% of the charter price
  // (snapshotted on the enquiry) to BookItMalta. 10% = BIM commission,
  // 10% remitted to the operator as the customer's deposit; balance (80%)
  // paid to the operator on the day. Fleet Admin platform-commission = €0
  // for BIM bookings.
  //
  // The legacy quote path (kind:'private_charter') still works — it is gated
  // on body.kind, not pricingModel — until the new booking page ships.
  catamaran: {
    slug: 'catamaran',
    name: 'Catamaran Malta — La Zingara & Chardonnay',
    operatorFirstName: 'Julian',    // BIM manages this operator relationship
    boat: 'La Zingara (Lagoon 450) + Chardonnay (Lagoon 440)',

    // Own Postgres schema in the shared Supabase project (catamaran_init_engine).
    schema: 'catamaran',

    // Pricing — 20% of the live charter price (from the availability feed,
    // snapshotted onto the enquiry as charter_price_cents at submission).
    pricingModel: 'percent_deposit',
    depositPercent: 0.20,
    charterPriceCents: 0,           // unused — price is per boat×experience×season
    depositAmountCents: 0,          // unused — see depositPercent
    currency: 'EUR',

    // Multi-boat fleet + external Fleet Admin integration (read-only + relay)
    boats: {
      'la-zingara':  { name: 'La Zingara',  model: 'Lagoon 450', capacity: 28 },
      'chardonnay':  { name: 'Chardonnay',  model: 'Lagoon 440', capacity: 24 },
    },
    // Validation cap for party_size (largest boat); per-boat capacity is
    // enforced again in the live-availability enquiry route.
    defaultCapPerDeparture: 28,
    availabilityFeedUrl: 'https://catamaranmalta.com/api/supabase-availability',
    enquiryRelayUrl:     'https://catamaranmalta.com/api/track-enquiry',
    waitlistRelayUrl:    'https://catamaranmalta.com/api/waitlist',
    relayEnquiryEmail:   'hello@bookitmalta.com',  // PII-free contact sent to Fleet Admin
    relayUtmSource:      'bookitmalta',

    // Policy
    cancellationWindowDays: 7,
    confirmationExpiryHours: 48,
    waitlistOfferExpiryHours: 24,

    // Routing
    publicPagePath: '/catamaran',
    confirmationAnchor: '#enquiry-confirmed',

    // Stripe Payment Link config (platform Stripe, like Bandama/UC)
    stripeProductName: 'BookItMalta deposit — Catamaran Malta private charter',
    stripeProductDescription: 'Deposit (20% of the charter price) charged by BookItMalta to secure your date and boat. The remaining balance is paid directly to Catamaran Malta on the day, as a separate transaction.',

    // Email branding
    emailFromName: 'Catamaran Malta (via BookItMalta)',
    emailReplyTo: null,             // resolved from CATAMARAN_OPERATOR_EMAIL if set

    // Whole-boat per date×boat×experience; treated as single-slot by the
    // legacy dashboard feed (multi-boat labels arrive with the ops UI phase).
    schedulingModel: 'single_slot_per_day',

    // Calendar event fields
    experienceDurationHours: 8,
    defaultStartTime: '10:00',
    meetingPointAddress: 'Sliema Ferries, Sliema, Malta',
    calendarEventTitle: 'Catamaran Malta — Private Charter',
    captainAllowlist: [
      'true-northdigital@outlook.com',             // Julian (BIM manages this tenant)
    ],
  },

  // Hosted whole-boat charter operator. Lives in its own Postgres schema
  // inside the shared Supabase project (like adventure-cruises). Two durations
  // (full / half day) priced via `charterOptions` — the engine reads the
  // selected option off the enquiry's tour_option. Platform Stripe (Bandama
  // model: deposit = BookItMalta's 12%, balance paid to the operator on the
  // day) — NOT Stripe Connect.
  'unexpected-charters-malta': {
    slug: 'unexpected-charters-malta',
    name: 'Unexpected Charters Malta',
    operatorFirstName: 'Darren',
    boat: 'Sagittarius Dart 436 (2000) · up to 10 guests',
    schema: 'unexpected_charters',

    pricingModel: 'flat_charter',
    // Per-duration pricing. charterPriceCents = full price the booking is worth;
    // depositAmountCents = the 12% taken online by BookItMalta at checkout; the
    // balance is collected by the operator on the day.
    charterOptions: {
      full: { label: 'Full day · 8h', charterPriceCents: 112000, depositAmountCents: 12000 },
      half: { label: 'Half day · 4h', charterPriceCents: 78400,  depositAmountCents: 8400  },
    },
    defaultCharterOption: 'full',
    // Fallbacks for any code path that doesn't pass an option (defaults to full day).
    charterPriceCents: 112000,
    depositAmountCents: 12000,
    currency: 'EUR',

    // Whole boat, single charter per day. defaultCapPerDeparture doubles as the
    // max party size in validation (whole-boat cap = 10 guests).
    defaultCapPerDeparture: 10,
    schedulingModel: 'single_slot_per_day',

    // Policy
    cancellationWindowDays: 7,        // full refund 7+ days before departure
    confirmationExpiryHours: 24,
    waitlistOfferExpiryHours: 24,

    // Routing
    publicPagePath: '/charters/unexpected-charters-malta',
    confirmationAnchor: '#enquiry-confirmed',

    // Stripe Payment Link config (platform Stripe)
    stripeProductName: 'BookItMalta booking fee — Unexpected Charters Malta',
    stripeProductDescription: 'Booking fee charged by BookItMalta to secure your private whole-boat charter around Comino, the Blue Lagoon and the south coast of Gozo. The balance is paid to the operator on the day.',

    emailFromName: 'Unexpected Charters Malta (via BookItMalta)',
    emailReplyTo: null,               // resolved from UNEXPECTED_CHARTERS_MALTA_OPERATOR_EMAIL

    // Calendar event fields
    experienceDurationHours: 8,
    meetingPointAddress: "Fekruna Jetty, St Paul's Bay, Malta",
    calendarEventTitle: 'Unexpected Charters — private day charter',

    captainAllowlist: [
      'darrenmizzi46@gmail.com',        // Darren (operator)
      'true-northdigital@outlook.com',  // Julian (owner)
    ],
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
