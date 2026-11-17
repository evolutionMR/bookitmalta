// api/_lib/tenants.config.js
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
    operatorFirstName: 'The captain',
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
    stripeProductName: 'BookItMalta deposit — Bandama charter',
    stripeProductDescription: 'Deposit charged by BookItMalta to secure your date for a full-day charter aboard Beneteau Swift Trawler 47. The charter price is paid directly to Bandama Yacht Charters on the day, as a separate transaction.',

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
      'simonborgcardona001@gmail.com',             // Simon Borg Cardona (Bandama operator)
      'true-northdigital@outlook.com',             // Julian (owner)
    ],
  },

  'adventure-cruises': {
    slug: 'adventure-cruises',
    name: 'Adventure Cruises',
    operatorFirstName: 'The captain',
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
    stripeProductName: 'BookItMalta deposit — Adventure Cruises day tour',
    stripeProductDescription: 'Deposit charged by BookItMalta to secure your seats on a shared day tour to Comino, the Blue Lagoon and Gozo. The remaining balance (€30 per seat) is paid to the crew on the day, as a separate transaction.',

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
  // (La Zingara + Chardonnay) is a SEPARATE operator from Bandama — NOT Simon.
  // Enquiries are captured via the /api/enquiry quote path (kind:'private_charter')
  // which only emails — it never touches the booking tables. Set the optional
  // env var CATAMARAN_OPERATOR_EMAIL to route quote emails to the operator
  // (auto-BCC'd to ADMIN_BCC_EMAIL); if unset, they fall back to the platform
  // admin / hello@bookitmalta.com so a lead is never dropped.
  catamaran: {
    slug: 'catamaran',
    name: 'Catamaran Malta — La Zingara & Chardonnay',
    operatorFirstName: 'The captain',
    boat: 'La Zingara (Lagoon 450) + Chardonnay (Lagoon 440)',
    pricingModel: 'quote',          // quote-only: never hits stripe/supabase math
    currency: 'EUR',
    publicPagePath: '/catamaran',
    confirmationAnchor: '#enquiry-confirmed',
    emailFromName: 'Catamaran Malta (via BookItMalta)',
    emailReplyTo: null,             // resolved from CATAMARAN_OPERATOR_EMAIL if set
    schedulingModel: 'quote',
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
    operatorFirstName: 'The captain',
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
    stripeProductName: 'BookItMalta deposit — Unexpected Charters Malta',
    stripeProductDescription: 'Deposit charged by BookItMalta to secure your private whole-boat charter around Comino, the Blue Lagoon and the south coast of Gozo. The balance is paid to the operator on the day.',

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

  // ---------------------------------------------------------------------------
  // TEST OPERATOR — not a real business. Exists so a booking can be tested end
  // to end (request -> captain yes -> deposit -> confirmed) without emailing a
  // real captain or customer and without moving real money.
  //
  // Safety rules, all enforced in code (not just by convention):
  //   1. `testOnly: true` tenants are REMOVED from TENANTS unless this
  //      deployment is a Vercel preview or local dev (see below). On the live
  //      site the slug behaves exactly like one that was never defined.
  //   2. Payments: getStripe() refuses any key that is not a Stripe TEST key.
  //   3. Email: sendEmail() refuses any recipient that is not in `testInboxes`,
  //      and validateEnquiry() rejects any other customer address up front.
  //   4. Data: its own Postgres schema, so test rows never mix with real ones.
  // There is no public page, no directory card and no sitemap entry for it.
  // ---------------------------------------------------------------------------
  'test-charter': {
    slug: 'test-charter',
    testOnly: true,
    name: 'Test Charter (not a real operator)',
    operatorFirstName: 'Test captain',
    boat: 'Test boat · up to 10 guests',
    schema: 'test_charter',

    // Inboxes a test may email. A plus-tag on the same mailbox is allowed
    // (name+anything@...), so one real inbox can play captain and customer.
    testInboxes: ['true-northdigital@outlook.com'],

    pricingModel: 'flat_charter',
    charterPriceCents: 100000,     // EUR 1,000.00 — made-up figure
    depositAmountCents: 12000,     // EUR 120.00 — made-up figure, test mode only
    currency: 'EUR',

    defaultCapPerDeparture: 10,
    schedulingModel: 'single_slot_per_day',

    cancellationWindowDays: 7,
    confirmationExpiryHours: 24,
    waitlistOfferExpiryHours: 24,

    // No page of its own; links in test emails land on the homepage.
    publicPagePath: '/',
    confirmationAnchor: '#enquiry-confirmed',

    stripeProductName: 'BookItMalta deposit — TEST charter (not a real booking)',
    stripeProductDescription: 'Test payment for the BookItMalta test operator. Not a real booking. No boat is reserved.',

    emailFromName: 'Test Charter (BookItMalta test)',
    emailReplyTo: null,            // resolved from TEST_CHARTER_OPERATOR_EMAIL

    experienceDurationHours: 8,
    defaultStartTime: '09:00',
    meetingPointAddress: 'Test meeting point (not a real place)',
    calendarEventTitle: 'TEST — not a real charter',

    captainAllowlist: [
      'true-northdigital@outlook.com',  // Julian (owner)
    ],
  },
};

// Test-only tenants exist ONLY on Vercel previews and local development.
// VERCEL_ENV is set by Vercel itself ('production' | 'preview' | 'development')
// and cannot be set by a request. Anything else — including production and an
// unset value — removes them, so the safe state is the default.
const TEST_TENANTS_ENABLED = ['preview', 'development'].includes(process.env.VERCEL_ENV);
if (!TEST_TENANTS_ENABLED) {
  for (const slug of Object.keys(TENANTS)) {
    if (TENANTS[slug].testOnly) delete TENANTS[slug];
  }
}

function getTenant(slug) {
  // Own-property lookup: a slug like "__proto__" or "constructor" must not
  // resolve to something inherited from Object.prototype.
  const tenant =
    typeof slug === 'string' && Object.prototype.hasOwnProperty.call(TENANTS, slug)
      ? TENANTS[slug]
      : null;
  if (!tenant) {
    throw new Error(`Unknown tenant: ${slug}`);
  }
  return tenant;
}

// True when `email` is one of a test tenant's allowed inboxes (exact match, or
// the same mailbox with a plus-tag). Always false for a non-test tenant config.
function isTestInbox(tenantConfig, email) {
  if (!tenantConfig || !tenantConfig.testOnly || typeof email !== 'string') return false;
  const addr = email.trim().toLowerCase();
  // One plain mailbox only: exactly one "@", at most one "+tag", no spaces,
  // commas, angle brackets, quotes or line breaks. Anything else is refused
  // here, so the lock does not depend on validation elsewhere.
  const m = /^([a-z0-9._-]+)(?:\+[a-z0-9._-]+)?(@[a-z0-9.-]+)$/.exec(addr);
  if (!m) return false;
  const base = `${m[1]}${m[2]}`;
  return (tenantConfig.testInboxes || []).some((x) => x.toLowerCase() === base);
}

function listTenants() {
  return Object.keys(TENANTS);
}

module.exports = { TENANTS, getTenant, listTenants, isTestInbox };
