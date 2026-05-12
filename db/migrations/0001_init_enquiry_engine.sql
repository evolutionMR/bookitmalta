-- =============================================================================
-- 0001_init_enquiry_engine.sql
-- BookItMalta — Enquiry Engine Phase 1
-- =============================================================================
--
-- Per-tenant Supabase project. Tenant identity is implicit (this entire
-- project belongs to one tenant — TENANT_SLUG resolved at build time in
-- the application layer). NO tenant_id column needed.
--
-- Tables:
--   enquiries  — customer enquiries (captured BEFORE captain confirms)
--   bookings   — confirmed + paid charters (the calendar truth)
--   waitlist   — customers waiting on already-booked dates
--
-- All tables have RLS enabled from this migration. Public anon key has no
-- access; the API layer uses the service-role key only on the server side.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: auto-update updated_at on row update
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- ENQUIRIES
-- =============================================================================
CREATE TABLE enquiries (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Customer
  customer_name             TEXT NOT NULL,
  customer_email            TEXT NOT NULL,
  customer_phone            TEXT,

  -- Charter
  preferred_date            DATE NOT NULL,
  alt_dates                 TEXT,                    -- free-text alternatives
  party_size                INT  NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  message                   TEXT,
  tour_option               TEXT,                    -- for tenants with multiple tour types (e.g. Adventure Cruises)

  -- Pricing snapshot (in cents) — captured at enquiry time so price changes
  -- never retroactively alter what was promised.
  charter_price_cents       INT  NOT NULL,
  deposit_amount_cents      INT  NOT NULL,
  currency                  TEXT NOT NULL DEFAULT 'EUR',

  -- State machine
  --   received   : just landed, awaiting captain decision
  --   confirmed  : captain said yes, Stripe link sent, awaiting payment
  --   paid       : deposit paid, booking record exists
  --   declined   : captain declined
  --   expired    : confirmed but customer didn't pay within window
  --   cancelled  : customer cancelled before captain action
  status                    TEXT NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received','confirmed','paid','declined','expired','cancelled')),

  -- Captain action (magic-link tokens — opaque, single-use intent)
  captain_token             TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  captain_action_at         TIMESTAMPTZ,
  captain_note              TEXT,

  -- Stripe
  stripe_payment_link_id    TEXT,
  stripe_payment_link_url   TEXT,
  stripe_payment_intent_id  TEXT,
  stripe_link_expires_at    TIMESTAMPTZ,
  paid_at                   TIMESTAMPTZ,

  -- Audit
  source                    TEXT DEFAULT 'web',      -- web | whatsapp | manual | etc.
  user_agent                TEXT,
  referrer                  TEXT,
  ip_hash                   TEXT,                    -- hashed IP for spam triage

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_enquiries_status            ON enquiries(status);
CREATE INDEX idx_enquiries_preferred_date    ON enquiries(preferred_date);
CREATE INDEX idx_enquiries_customer_email    ON enquiries(customer_email);
CREATE INDEX idx_enquiries_captain_token     ON enquiries(captain_token);
CREATE INDEX idx_enquiries_created_at        ON enquiries(created_at DESC);

CREATE TRIGGER trg_enquiries_updated_at
  BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
-- No policies → anon/authenticated roles have ZERO access.
-- Only the service-role key (server-side) can read/write.

-- =============================================================================
-- BOOKINGS
-- =============================================================================
CREATE TABLE bookings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id                UUID NOT NULL REFERENCES enquiries(id) ON DELETE RESTRICT,

  -- Denormalised customer + charter snapshot for fast portal queries
  customer_name             TEXT NOT NULL,
  customer_email            TEXT NOT NULL,
  customer_phone            TEXT,
  charter_date              DATE NOT NULL,
  party_size                INT  NOT NULL,
  tour_option               TEXT,

  -- Financial
  deposit_paid_cents        INT  NOT NULL,
  balance_due_cents         INT  NOT NULL,
  currency                  TEXT NOT NULL DEFAULT 'EUR',
  stripe_payment_intent_id  TEXT NOT NULL,
  stripe_charge_id          TEXT,

  -- State
  --   booked      : deposit paid, charter is ahead
  --   completed   : charter has happened
  --   cancelled   : customer cancelled (within refund window or not)
  --   refunded    : refund issued
  --   no_show     : customer didn't turn up
  status                    TEXT NOT NULL DEFAULT 'booked'
                            CHECK (status IN ('booked','completed','cancelled','refunded','no_show')),
  cancelled_at              TIMESTAMPTZ,
  cancelled_reason          TEXT,
  refund_amount_cents       INT NOT NULL DEFAULT 0,
  refund_processed_at       TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_charter_date ON bookings(charter_date);
CREATE INDEX idx_bookings_status       ON bookings(status);
CREATE INDEX idx_bookings_enquiry_id   ON bookings(enquiry_id);

-- HARD CONSTRAINT: only one ACTIVE booking per charter_date.
-- Cancelled/refunded/no_show bookings are excluded so the date can be re-booked.
-- For single-boat / single-slot-per-day tenants like Bandama this is correct.
-- For tenants with multiple slots per day (Adventure Cruises: 09:30, 14:30),
-- add a `slot` column and include it in the partial index.
CREATE UNIQUE INDEX idx_bookings_one_active_per_date
  ON bookings(charter_date)
  WHERE status IN ('booked','completed');

CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- WAITLIST
-- =============================================================================
CREATE TABLE waitlist (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id                UUID NOT NULL REFERENCES enquiries(id) ON DELETE RESTRICT,

  customer_name             TEXT NOT NULL,
  customer_email            TEXT NOT NULL,
  customer_phone            TEXT,
  requested_date            DATE NOT NULL,
  alt_dates                 TEXT,
  party_size                INT  NOT NULL,
  message                   TEXT,
  tour_option               TEXT,

  -- State
  --   waiting    : on the list, hasn't been offered the slot
  --   notified   : slot opened, offer email sent, awaiting customer action
  --   converted  : customer accepted, became an enquiry/booking
  --   expired    : notified but didn't act in time
  --   released   : customer pulled themselves out
  status                    TEXT NOT NULL DEFAULT 'waiting'
                            CHECK (status IN ('waiting','notified','converted','expired','released')),
  position                  INT  NOT NULL,

  -- When slot opens, customer gets a tokenised "claim it" link
  notification_token        TEXT UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  notified_at               TIMESTAMPTZ,
  notification_expires_at   TIMESTAMPTZ,

  converted_to_enquiry_id   UUID REFERENCES enquiries(id),

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_waitlist_requested_date_status ON waitlist(requested_date, status);
CREATE INDEX idx_waitlist_status                ON waitlist(status);
CREATE INDEX idx_waitlist_position              ON waitlist(requested_date, position);

CREATE TRIGGER trg_waitlist_updated_at
  BEFORE UPDATE ON waitlist
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- HELPER: is_date_taken(date) — true if any active booking exists for date
-- =============================================================================
CREATE OR REPLACE FUNCTION is_date_taken(p_date DATE)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM bookings
    WHERE charter_date = p_date
      AND status IN ('booked','completed')
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- HELPER: next_waitlist_position(date) — for assigning queue position
-- =============================================================================
CREATE OR REPLACE FUNCTION next_waitlist_position(p_date DATE)
RETURNS INT AS $$
DECLARE
  next_pos INT;
BEGIN
  SELECT COALESCE(MAX(position), 0) + 1
    INTO next_pos
    FROM waitlist
   WHERE requested_date = p_date
     AND status IN ('waiting','notified');
  RETURN next_pos;
END;
$$ LANGUAGE plpgsql STABLE;
