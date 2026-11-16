-- BookItMalta bookings database: structure copied from the old project on 16 Nov 2026.
-- One walled-off section (schema) per operator. Every table has row level security on and no policies:
-- only the server key can read or write.
begin;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists adventure_cruises;
create schema if not exists unexpected_charters;
create schema if not exists catamaran;
create schema if not exists test_charter;

-- tables
CREATE TABLE adventure_cruises.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  charter_date date NOT NULL,
  slot_time text,
  party_size integer NOT NULL,
  booking_fee_paid_cents integer,
  balance_due_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  stripe_charge_id text,
  assigned_boat text,
  status text DEFAULT 'booked'::text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_reason text,
  refund_amount_cents integer DEFAULT 0 NOT NULL,
  refund_processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tour_option text,
  deposit_paid_cents integer,
  charter_date_legacy date,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE adventure_cruises.cap_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  charter_date date NOT NULL,
  slot_time text NOT NULL,
  max_seats integer NOT NULL,
  reason text,
  set_by_email text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE adventure_cruises.captain_pins (
  email text NOT NULL,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  must_change boolean DEFAULT true NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE adventure_cruises.enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  preferred_date date NOT NULL,
  slot_time text,
  party_size integer NOT NULL,
  alt_dates text,
  message text,
  price_per_seat_cents integer DEFAULT 4000,
  booking_fee_per_seat_cents integer DEFAULT 1000,
  total_price_cents integer,
  booking_fee_cents integer,
  balance_due_cents integer,
  currency text DEFAULT 'EUR'::text NOT NULL,
  status text DEFAULT 'received'::text NOT NULL,
  captain_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL,
  captain_action_at timestamp with time zone,
  captain_note text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_payment_intent_id text,
  stripe_link_expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  source text DEFAULT 'web'::text,
  user_agent text,
  referrer text,
  ip_hash text,
  terms_accepted_at timestamp with time zone,
  terms_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tour_option text,
  charter_price_cents integer,
  deposit_amount_cents integer,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE adventure_cruises.login_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant text NOT NULL,
  email text NOT NULL,
  code_hash text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  used_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_hash text,
  user_agent text
);
CREATE TABLE adventure_cruises.schedule_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  rule_type text NOT NULL,
  params jsonb NOT NULL,
  reason text,
  set_by_email text,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE adventure_cruises.waitlist (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  requested_date date NOT NULL,
  slot_time text,
  party_size integer NOT NULL,
  alt_dates text,
  message text,
  status text DEFAULT 'waiting'::text NOT NULL,
  "position" integer NOT NULL,
  notification_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text),
  notified_at timestamp with time zone,
  notification_expires_at timestamp with time zone,
  converted_to_enquiry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  tour_option text
);
CREATE TABLE catamaran.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  charter_date date NOT NULL,
  party_size integer NOT NULL,
  tour_option text,
  deposit_paid_cents integer NOT NULL,
  balance_due_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  stripe_charge_id text,
  status text DEFAULT 'booked'::text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_reason text,
  refund_amount_cents integer DEFAULT 0 NOT NULL,
  refund_processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text,
  boat_slug text,
  fleet_admin_ref text
);
CREATE TABLE catamaran.captain_pins (
  email text NOT NULL,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  must_change boolean DEFAULT true NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE catamaran.enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  preferred_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  charter_price_cents integer NOT NULL,
  deposit_amount_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  status text DEFAULT 'received'::text NOT NULL,
  captain_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL,
  captain_action_at timestamp with time zone,
  captain_note text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_payment_intent_id text,
  stripe_link_expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  source text DEFAULT 'web'::text,
  user_agent text,
  referrer text,
  ip_hash text,
  terms_accepted_at timestamp with time zone,
  terms_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text,
  boat_slug text,
  fleet_admin_ref text
);
CREATE TABLE catamaran.waitlist (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  requested_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  status text DEFAULT 'waiting'::text NOT NULL,
  "position" integer NOT NULL,
  notification_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text),
  notified_at timestamp with time zone,
  notification_expires_at timestamp with time zone,
  converted_to_enquiry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  charter_date date NOT NULL,
  party_size integer NOT NULL,
  tour_option text,
  deposit_paid_cents integer NOT NULL,
  balance_due_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  stripe_charge_id text,
  status text DEFAULT 'booked'::text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_reason text,
  refund_amount_cents integer DEFAULT 0 NOT NULL,
  refund_processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE public.captain_pins (
  email text NOT NULL,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  must_change boolean DEFAULT true NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  preferred_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  charter_price_cents integer NOT NULL,
  deposit_amount_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  status text DEFAULT 'received'::text NOT NULL,
  captain_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL,
  captain_action_at timestamp with time zone,
  captain_note text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_payment_intent_id text,
  stripe_link_expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  source text DEFAULT 'web'::text,
  user_agent text,
  referrer text,
  ip_hash text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  terms_accepted_at timestamp with time zone,
  terms_version text,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE public.login_codes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tenant text NOT NULL,
  email text NOT NULL,
  code_hash text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  used_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  ip_hash text,
  user_agent text
);
CREATE TABLE public.waitlist (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  requested_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  status text DEFAULT 'waiting'::text NOT NULL,
  "position" integer NOT NULL,
  notification_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text),
  notified_at timestamp with time zone,
  notification_expires_at timestamp with time zone,
  converted_to_enquiry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE unexpected_charters.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  charter_date date NOT NULL,
  party_size integer NOT NULL,
  tour_option text,
  deposit_paid_cents integer NOT NULL,
  balance_due_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  stripe_charge_id text,
  status text DEFAULT 'booked'::text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_reason text,
  refund_amount_cents integer DEFAULT 0 NOT NULL,
  refund_processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE unexpected_charters.captain_pins (
  email text NOT NULL,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  must_change boolean DEFAULT true NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE unexpected_charters.enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  preferred_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  charter_price_cents integer NOT NULL,
  deposit_amount_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  status text DEFAULT 'received'::text NOT NULL,
  captain_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL,
  captain_action_at timestamp with time zone,
  captain_note text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_payment_intent_id text,
  stripe_link_expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  source text DEFAULT 'web'::text,
  user_agent text,
  referrer text,
  ip_hash text,
  terms_accepted_at timestamp with time zone,
  terms_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE unexpected_charters.waitlist (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  requested_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  status text DEFAULT 'waiting'::text NOT NULL,
  "position" integer NOT NULL,
  notification_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text),
  notified_at timestamp with time zone,
  notification_expires_at timestamp with time zone,
  converted_to_enquiry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- functions
CREATE OR REPLACE FUNCTION adventure_cruises.check_schedule_rules(p_date date, p_slot text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'adventure_cruises', 'public'
AS $function$
DECLARE
    v_rule   record;
    v_dow    integer;
    v_slot_json jsonb := to_jsonb(p_slot);
BEGIN
    v_dow := EXTRACT(DOW FROM p_date)::integer; -- 0=Sun, 6=Sat

    FOR v_rule IN
        SELECT rule_type, params, reason
          FROM adventure_cruises.schedule_rules
         WHERE active = true
    LOOP
        CASE v_rule.rule_type

        WHEN 'weekly_blackout' THEN
            -- days_of_week must contain v_dow
            IF NOT (v_rule.params -> 'days_of_week') @> to_jsonb(v_dow) THEN
                CONTINUE;
            END IF;
            -- slots: null/missing/"null" => all slots; else must include p_slot
            IF v_rule.params ? 'slots'
               AND v_rule.params -> 'slots' IS NOT NULL
               AND jsonb_typeof(v_rule.params -> 'slots') = 'array'
               AND NOT (v_rule.params -> 'slots') @> v_slot_json THEN
                CONTINUE;
            END IF;
            RETURN COALESCE(v_rule.reason, 'Closed (weekly schedule)');

        WHEN 'date_range_blackout' THEN
            IF p_date >= (v_rule.params ->> 'start_date')::date
               AND p_date <= (v_rule.params ->> 'end_date')::date THEN
                RETURN COALESCE(v_rule.reason, 'Closed (season)');
            END IF;

        WHEN 'recurring_capacity' THEN
            -- Capacity rules don't BLOCK, they reduce — handled in
            -- get_departure_availability, not here.
            NULL;

        ELSE
            NULL;
        END CASE;
    END LOOP;

    RETURN NULL;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.get_departure_availability(p_date date, p_slot text, p_party_size integer DEFAULT 1)
 RETURNS TABLE(total_cap integer, seats_taken integer, seats_available integer, can_accommodate boolean, is_blocked boolean, block_reason text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'adventure_cruises', 'public'
AS $function$
DECLARE
    v_default_cap        integer := 80;
    v_override_cap       integer;
    v_override_reason    text;
    v_recurring_cap      integer;
    v_resolved_cap       integer;
    v_seats_taken        integer;
    v_rule_block_reason  text;
    v_block_reason_out   text;
    v_is_blocked         boolean;
BEGIN
    -- (A) Hard blackout rules (highest priority on the reason)
    v_rule_block_reason := adventure_cruises.check_schedule_rules(p_date, p_slot);

    -- (B) Ad-hoc override — capture reason too
    SELECT max_seats, reason
      INTO v_override_cap, v_override_reason
      FROM adventure_cruises.cap_overrides
     WHERE charter_date = p_date AND slot_time = p_slot
     LIMIT 1;

    -- (C) Recurring capacity reduction
    v_recurring_cap := adventure_cruises.recurring_capacity_for(p_date, p_slot);

    -- Resolution: explicit ad-hoc override wins; else most-restrictive of
    -- recurring rule + default.
    IF v_override_cap IS NOT NULL THEN
        v_resolved_cap := v_override_cap;
    ELSE
        v_resolved_cap := LEAST(
            COALESCE(v_recurring_cap, v_default_cap),
            v_default_cap
        );
    END IF;

    -- Sum confirmed-or-completed seats already booked on this departure.
    -- 'cancelled', 'refunded' rows do NOT consume capacity.
    SELECT COALESCE(SUM(b.party_size), 0)
      INTO v_seats_taken
      FROM adventure_cruises.bookings b
     WHERE b.charter_date = p_date
       AND b.slot_time    = p_slot
       AND b.status IN ('booked', 'completed');

    v_is_blocked := (v_resolved_cap <= 0) OR (v_rule_block_reason IS NOT NULL);

    -- Reason priority: schedule rule > cap_override.reason > generic fallback
    IF v_rule_block_reason IS NOT NULL THEN
        v_block_reason_out := v_rule_block_reason;
    ELSIF v_resolved_cap <= 0 THEN
        v_block_reason_out := COALESCE(
            NULLIF(TRIM(v_override_reason), ''),
            'Departure blocked by operator'
        );
    ELSE
        v_block_reason_out := NULL;
    END IF;

    total_cap       := v_resolved_cap;
    seats_taken     := v_seats_taken;
    seats_available := GREATEST(0, v_resolved_cap - v_seats_taken);
    can_accommodate := (NOT v_is_blocked)
                      AND (seats_available >= COALESCE(p_party_size, 1));
    is_blocked      := v_is_blocked;
    block_reason    := v_block_reason_out;

    RETURN NEXT;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.is_date_taken(p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'adventure_cruises', 'public'
AS $function$
DECLARE
    v_slot         text;
    v_slots        text[] := ARRAY['09:30', '14:30'];
    v_avail        record;
    v_all_unavail  boolean := true;
BEGIN
    FOREACH v_slot IN ARRAY v_slots LOOP
        SELECT * INTO v_avail
          FROM adventure_cruises.get_departure_availability(p_date, v_slot, 1);
        IF NOT v_avail.is_blocked AND v_avail.seats_available > 0 THEN
            v_all_unavail := false;
            EXIT;
        END IF;
    END LOOP;
    RETURN v_all_unavail;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.next_waitlist_position(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    next_pos integer;
BEGIN
    SELECT COALESCE(MAX(position), 0) + 1
      INTO next_pos
      FROM adventure_cruises.waitlist
     WHERE requested_date = p_date
       AND status IN ('waiting', 'notified');
    RETURN next_pos;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.recurring_capacity_for(p_date date, p_slot text)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'adventure_cruises', 'public'
AS $function$
DECLARE
    v_rule   record;
    v_dow    integer;
    v_slot_json jsonb := to_jsonb(p_slot);
    v_min_cap integer := NULL;
BEGIN
    v_dow := EXTRACT(DOW FROM p_date)::integer;

    FOR v_rule IN
        SELECT params
          FROM adventure_cruises.schedule_rules
         WHERE active = true AND rule_type = 'recurring_capacity'
    LOOP
        IF NOT (v_rule.params -> 'days_of_week') @> to_jsonb(v_dow) THEN
            CONTINUE;
        END IF;
        IF v_rule.params ? 'slots'
           AND v_rule.params -> 'slots' IS NOT NULL
           AND jsonb_typeof(v_rule.params -> 'slots') = 'array'
           AND NOT (v_rule.params -> 'slots') @> v_slot_json THEN
            CONTINUE;
        END IF;

        v_min_cap := LEAST(
            COALESCE(v_min_cap, 2147483647),
            (v_rule.params ->> 'max_seats')::integer
        );
    END LOOP;

    RETURN v_min_cap;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.tg_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.tg_sync_booking_fee_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    IF NEW.booking_fee_paid_cents IS NULL AND NEW.deposit_paid_cents IS NOT NULL THEN
        NEW.booking_fee_paid_cents := NEW.deposit_paid_cents;
    ELSIF NEW.deposit_paid_cents IS NULL AND NEW.booking_fee_paid_cents IS NOT NULL THEN
        NEW.deposit_paid_cents := NEW.booking_fee_paid_cents;
    END IF;
    RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION adventure_cruises.tg_sync_slot_tour_option()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    -- Whichever was provided fills the other
    IF NEW.tour_option IS NULL AND NEW.slot_time IS NOT NULL THEN
        NEW.tour_option := NEW.slot_time;
    ELSIF NEW.slot_time IS NULL AND NEW.tour_option IS NOT NULL THEN
        NEW.slot_time := NEW.tour_option;
    END IF;
    RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION catamaran.is_date_taken(p_date date, p_boat_slug text, p_tour text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1 from catamaran.bookings
    where charter_date = p_date
      and boat_slug = p_boat_slug
      and tour_option = p_tour
      and status in ('booked','completed')
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION catamaran.next_waitlist_position(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare next_pos int;
begin
  select coalesce(max(position),0)+1 into next_pos
  from catamaran.waitlist
  where requested_date = p_date and status in ('waiting','notified');
  return next_pos;
end;
$function$
;
CREATE OR REPLACE FUNCTION catamaran.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.is_date_taken(p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM bookings
    WHERE charter_date = p_date
      AND status IN ('booked','completed')
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.next_waitlist_position(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION unexpected_charters.is_date_taken(p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  return exists (
    select 1 from unexpected_charters.bookings
    where charter_date = p_date and status in ('booked','completed')
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION unexpected_charters.next_waitlist_position(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $function$
declare next_pos int;
begin
  select coalesce(max(position),0)+1 into next_pos
  from unexpected_charters.waitlist
  where requested_date = p_date and status in ('waiting','notified');
  return next_pos;
end;
$function$
;
CREATE OR REPLACE FUNCTION unexpected_charters.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

-- keys and checks
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_assigned_boat_check CHECK (((assigned_boat IS NULL) OR (assigned_boat = ANY (ARRAY['albert_v'::text, 'adventure_1'::text]))));
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_party_size_check CHECK (((party_size >= 1) AND (party_size <= 80)));
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_slot_time_check CHECK ((slot_time = ANY (ARRAY['09:30'::text, '14:30'::text])));
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text, 'no_show'::text])));
ALTER TABLE adventure_cruises.cap_overrides ADD CONSTRAINT cap_overrides_charter_date_slot_time_key UNIQUE (charter_date, slot_time);
ALTER TABLE adventure_cruises.cap_overrides ADD CONSTRAINT cap_overrides_max_seats_check CHECK (((max_seats >= 0) AND (max_seats <= 80)));
ALTER TABLE adventure_cruises.cap_overrides ADD CONSTRAINT cap_overrides_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.cap_overrides ADD CONSTRAINT cap_overrides_slot_time_check CHECK ((slot_time = ANY (ARRAY['09:30'::text, '14:30'::text])));
ALTER TABLE adventure_cruises.captain_pins ADD CONSTRAINT captain_pins_pkey PRIMARY KEY (email);
ALTER TABLE adventure_cruises.enquiries ADD CONSTRAINT enquiries_captain_token_key UNIQUE (captain_token);
ALTER TABLE adventure_cruises.enquiries ADD CONSTRAINT enquiries_party_size_check CHECK (((party_size >= 1) AND (party_size <= 80)));
ALTER TABLE adventure_cruises.enquiries ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.enquiries ADD CONSTRAINT enquiries_slot_time_check CHECK ((slot_time = ANY (ARRAY['09:30'::text, '14:30'::text])));
ALTER TABLE adventure_cruises.enquiries ADD CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE adventure_cruises.login_codes ADD CONSTRAINT login_codes_email_check CHECK ((email <> ''::text));
ALTER TABLE adventure_cruises.login_codes ADD CONSTRAINT login_codes_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.login_codes ADD CONSTRAINT login_codes_tenant_check CHECK ((tenant <> ''::text));
ALTER TABLE adventure_cruises.schedule_rules ADD CONSTRAINT schedule_rules_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.schedule_rules ADD CONSTRAINT schedule_rules_rule_type_check CHECK ((rule_type = ANY (ARRAY['weekly_blackout'::text, 'date_range_blackout'::text, 'recurring_capacity'::text])));
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_notification_token_key UNIQUE (notification_token);
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_party_size_check CHECK (((party_size >= 1) AND (party_size <= 80)));
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_slot_time_check CHECK ((slot_time = ANY (ARRAY['09:30'::text, '14:30'::text])));
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'converted'::text, 'expired'::text, 'released'::text])));
ALTER TABLE catamaran.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE catamaran.bookings ADD CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text, 'no_show'::text])));
ALTER TABLE catamaran.captain_pins ADD CONSTRAINT captain_pins_pkey PRIMARY KEY (email);
ALTER TABLE catamaran.enquiries ADD CONSTRAINT enquiries_captain_token_key UNIQUE (captain_token);
ALTER TABLE catamaran.enquiries ADD CONSTRAINT enquiries_party_size_check CHECK (((party_size >= 1) AND (party_size <= 20)));
ALTER TABLE catamaran.enquiries ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);
ALTER TABLE catamaran.enquiries ADD CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE catamaran.waitlist ADD CONSTRAINT waitlist_notification_token_key UNIQUE (notification_token);
ALTER TABLE catamaran.waitlist ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);
ALTER TABLE catamaran.waitlist ADD CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'converted'::text, 'expired'::text, 'released'::text])));
ALTER TABLE public.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text, 'no_show'::text])));
ALTER TABLE public.captain_pins ADD CONSTRAINT captain_pins_pkey PRIMARY KEY (email);
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_captain_token_key UNIQUE (captain_token);
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_party_size_check CHECK (((party_size >= 1) AND (party_size <= 20)));
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);
ALTER TABLE public.enquiries ADD CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE public.login_codes ADD CONSTRAINT login_codes_email_check CHECK ((email <> ''::text));
ALTER TABLE public.login_codes ADD CONSTRAINT login_codes_pkey PRIMARY KEY (id);
ALTER TABLE public.login_codes ADD CONSTRAINT login_codes_tenant_check CHECK ((tenant <> ''::text));
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_notification_token_key UNIQUE (notification_token);
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'converted'::text, 'expired'::text, 'released'::text])));
ALTER TABLE unexpected_charters.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE unexpected_charters.bookings ADD CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text, 'no_show'::text])));
ALTER TABLE unexpected_charters.captain_pins ADD CONSTRAINT captain_pins_pkey PRIMARY KEY (email);
ALTER TABLE unexpected_charters.enquiries ADD CONSTRAINT enquiries_captain_token_key UNIQUE (captain_token);
ALTER TABLE unexpected_charters.enquiries ADD CONSTRAINT enquiries_party_size_check CHECK (((party_size >= 1) AND (party_size <= 20)));
ALTER TABLE unexpected_charters.enquiries ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);
ALTER TABLE unexpected_charters.enquiries ADD CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE unexpected_charters.waitlist ADD CONSTRAINT waitlist_notification_token_key UNIQUE (notification_token);
ALTER TABLE unexpected_charters.waitlist ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);
ALTER TABLE unexpected_charters.waitlist ADD CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'converted'::text, 'expired'::text, 'released'::text])));
ALTER TABLE adventure_cruises.bookings ADD CONSTRAINT bookings_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES adventure_cruises.enquiries(id);
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_converted_to_enquiry_id_fkey FOREIGN KEY (converted_to_enquiry_id) REFERENCES adventure_cruises.enquiries(id);
ALTER TABLE adventure_cruises.waitlist ADD CONSTRAINT waitlist_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES adventure_cruises.enquiries(id);
ALTER TABLE public.bookings ADD CONSTRAINT bookings_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES enquiries(id) ON DELETE RESTRICT;
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_converted_to_enquiry_id_fkey FOREIGN KEY (converted_to_enquiry_id) REFERENCES enquiries(id);
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES enquiries(id) ON DELETE RESTRICT;
ALTER TABLE unexpected_charters.bookings ADD CONSTRAINT bookings_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES unexpected_charters.enquiries(id) ON DELETE RESTRICT;
ALTER TABLE unexpected_charters.waitlist ADD CONSTRAINT waitlist_converted_to_enquiry_id_fkey FOREIGN KEY (converted_to_enquiry_id) REFERENCES unexpected_charters.enquiries(id);
ALTER TABLE unexpected_charters.waitlist ADD CONSTRAINT waitlist_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES unexpected_charters.enquiries(id) ON DELETE RESTRICT;

-- indexes
CREATE INDEX bok_archived_ac ON adventure_cruises.bookings USING btree (archived_at);
CREATE INDEX bookings_assigned_boat_idx ON adventure_cruises.bookings USING btree (assigned_boat) WHERE (assigned_boat IS NOT NULL);
CREATE INDEX bookings_date_slot_idx ON adventure_cruises.bookings USING btree (charter_date, slot_time);
CREATE INDEX bookings_status_idx ON adventure_cruises.bookings USING btree (status);
CREATE INDEX enq_archived_ac ON adventure_cruises.enquiries USING btree (archived_at);
CREATE INDEX enquiries_created_idx ON adventure_cruises.enquiries USING btree (created_at DESC);
CREATE INDEX enquiries_date_slot_idx ON adventure_cruises.enquiries USING btree (preferred_date, slot_time);
CREATE INDEX enquiries_status_idx ON adventure_cruises.enquiries USING btree (status);
CREATE INDEX login_codes_email_active_idx ON adventure_cruises.login_codes USING btree (email, expires_at) WHERE (used_at IS NULL);
CREATE INDEX login_codes_expires_idx ON adventure_cruises.login_codes USING btree (expires_at);
CREATE INDEX schedule_rules_active_idx ON adventure_cruises.schedule_rules USING btree (rule_type) WHERE active;
CREATE INDEX waitlist_date_slot_idx ON adventure_cruises.waitlist USING btree (requested_date, slot_time);
CREATE INDEX waitlist_status_idx ON adventure_cruises.waitlist USING btree (status);
CREATE INDEX bookings_archived_at_idx ON catamaran.bookings USING btree (archived_at);
CREATE INDEX bookings_charter_date_idx ON catamaran.bookings USING btree (charter_date);
CREATE UNIQUE INDEX bookings_charter_date_idx1 ON catamaran.bookings USING btree (charter_date) WHERE (status = ANY (ARRAY['booked'::text, 'completed'::text]));
CREATE INDEX bookings_enquiry_id_idx ON catamaran.bookings USING btree (enquiry_id);
CREATE INDEX bookings_status_idx ON catamaran.bookings USING btree (status);
CREATE INDEX catamaran_bok_boat_date ON catamaran.bookings USING btree (boat_slug, charter_date);
CREATE INDEX catamaran_enq_boat_date ON catamaran.enquiries USING btree (boat_slug, preferred_date);
CREATE INDEX enquiries_archived_at_idx ON catamaran.enquiries USING btree (archived_at);
CREATE INDEX enquiries_captain_token_idx ON catamaran.enquiries USING btree (captain_token);
CREATE INDEX enquiries_created_at_idx ON catamaran.enquiries USING btree (created_at DESC);
CREATE INDEX enquiries_customer_email_idx ON catamaran.enquiries USING btree (customer_email);
CREATE INDEX enquiries_preferred_date_idx ON catamaran.enquiries USING btree (preferred_date);
CREATE INDEX enquiries_status_idx ON catamaran.enquiries USING btree (status);
CREATE INDEX waitlist_requested_date_position_idx ON catamaran.waitlist USING btree (requested_date, "position");
CREATE INDEX waitlist_requested_date_status_idx ON catamaran.waitlist USING btree (requested_date, status);
CREATE INDEX waitlist_status_idx ON catamaran.waitlist USING btree (status);
CREATE INDEX bok_archived_public ON public.bookings USING btree (archived_at);
CREATE INDEX enq_archived_public ON public.enquiries USING btree (archived_at);
CREATE INDEX idx_bookings_charter_date ON public.bookings USING btree (charter_date);
CREATE INDEX idx_bookings_enquiry_id ON public.bookings USING btree (enquiry_id);
CREATE UNIQUE INDEX idx_bookings_one_active_per_date ON public.bookings USING btree (charter_date) WHERE (status = ANY (ARRAY['booked'::text, 'completed'::text]));
CREATE INDEX idx_bookings_status ON public.bookings USING btree (status);
CREATE INDEX idx_enquiries_captain_token ON public.enquiries USING btree (captain_token);
CREATE INDEX idx_enquiries_created_at ON public.enquiries USING btree (created_at DESC);
CREATE INDEX idx_enquiries_customer_email ON public.enquiries USING btree (customer_email);
CREATE INDEX idx_enquiries_preferred_date ON public.enquiries USING btree (preferred_date);
CREATE INDEX idx_enquiries_status ON public.enquiries USING btree (status);
CREATE INDEX idx_enquiries_terms_accepted_at ON public.enquiries USING btree (terms_accepted_at);
CREATE INDEX idx_waitlist_position ON public.waitlist USING btree (requested_date, "position");
CREATE INDEX idx_waitlist_requested_date_status ON public.waitlist USING btree (requested_date, status);
CREATE INDEX idx_waitlist_status ON public.waitlist USING btree (status);
CREATE INDEX login_codes_email_active_idx ON public.login_codes USING btree (email, expires_at) WHERE (used_at IS NULL);
CREATE INDEX login_codes_expires_idx ON public.login_codes USING btree (expires_at);
CREATE INDEX bok_archived_uc ON unexpected_charters.bookings USING btree (archived_at);
CREATE INDEX enq_archived_uc ON unexpected_charters.enquiries USING btree (archived_at);
CREATE INDEX idx_uc_bookings_charter_date ON unexpected_charters.bookings USING btree (charter_date);
CREATE INDEX idx_uc_bookings_enquiry_id ON unexpected_charters.bookings USING btree (enquiry_id);
CREATE UNIQUE INDEX idx_uc_bookings_one_active_per_date ON unexpected_charters.bookings USING btree (charter_date) WHERE (status = ANY (ARRAY['booked'::text, 'completed'::text]));
CREATE INDEX idx_uc_bookings_status ON unexpected_charters.bookings USING btree (status);
CREATE INDEX idx_uc_enquiries_captain_token ON unexpected_charters.enquiries USING btree (captain_token);
CREATE INDEX idx_uc_enquiries_created_at ON unexpected_charters.enquiries USING btree (created_at DESC);
CREATE INDEX idx_uc_enquiries_customer_email ON unexpected_charters.enquiries USING btree (customer_email);
CREATE INDEX idx_uc_enquiries_preferred_date ON unexpected_charters.enquiries USING btree (preferred_date);
CREATE INDEX idx_uc_enquiries_status ON unexpected_charters.enquiries USING btree (status);
CREATE INDEX idx_uc_waitlist_position ON unexpected_charters.waitlist USING btree (requested_date, "position");
CREATE INDEX idx_uc_waitlist_req_date_status ON unexpected_charters.waitlist USING btree (requested_date, status);
CREATE INDEX idx_uc_waitlist_status ON unexpected_charters.waitlist USING btree (status);

-- triggers
CREATE TRIGGER set_updated_at BEFORE UPDATE ON adventure_cruises.bookings FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_set_updated_at();
CREATE TRIGGER sync_booking_fee_columns BEFORE INSERT OR UPDATE ON adventure_cruises.bookings FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_sync_booking_fee_columns();
CREATE TRIGGER sync_slot_tour_option BEFORE INSERT OR UPDATE ON adventure_cruises.bookings FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_sync_slot_tour_option();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON adventure_cruises.cap_overrides FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON adventure_cruises.enquiries FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_set_updated_at();
CREATE TRIGGER sync_slot_tour_option BEFORE INSERT OR UPDATE ON adventure_cruises.enquiries FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_sync_slot_tour_option();
CREATE TRIGGER schedule_rules_updated_at BEFORE UPDATE ON adventure_cruises.schedule_rules FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON adventure_cruises.waitlist FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_set_updated_at();
CREATE TRIGGER sync_slot_tour_option BEFORE INSERT OR UPDATE ON adventure_cruises.waitlist FOR EACH ROW EXECUTE FUNCTION adventure_cruises.tg_sync_slot_tour_option();
CREATE TRIGGER trg_bok_updated BEFORE UPDATE ON catamaran.bookings FOR EACH ROW EXECUTE FUNCTION catamaran.set_updated_at();
CREATE TRIGGER trg_pin_updated BEFORE UPDATE ON catamaran.captain_pins FOR EACH ROW EXECUTE FUNCTION catamaran.set_updated_at();
CREATE TRIGGER trg_enq_updated BEFORE UPDATE ON catamaran.enquiries FOR EACH ROW EXECUTE FUNCTION catamaran.set_updated_at();
CREATE TRIGGER trg_wl_updated BEFORE UPDATE ON catamaran.waitlist FOR EACH ROW EXECUTE FUNCTION catamaran.set_updated_at();
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_enquiries_updated_at BEFORE UPDATE ON public.enquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_waitlist_updated_at BEFORE UPDATE ON public.waitlist FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_uc_bookings_updated_at BEFORE UPDATE ON unexpected_charters.bookings FOR EACH ROW EXECUTE FUNCTION unexpected_charters.set_updated_at();
CREATE TRIGGER trg_uc_enquiries_updated_at BEFORE UPDATE ON unexpected_charters.enquiries FOR EACH ROW EXECUTE FUNCTION unexpected_charters.set_updated_at();
CREATE TRIGGER trg_uc_waitlist_updated_at BEFORE UPDATE ON unexpected_charters.waitlist FOR EACH ROW EXECUTE FUNCTION unexpected_charters.set_updated_at();

-- row level security
ALTER TABLE adventure_cruises.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.cap_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.captain_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.schedule_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE adventure_cruises.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE catamaran.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE catamaran.captain_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE catamaran.enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE catamaran.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captain_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE unexpected_charters.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE unexpected_charters.captain_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE unexpected_charters.enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE unexpected_charters.waitlist ENABLE ROW LEVEL SECURITY;

-- comments
COMMENT ON TABLE adventure_cruises.bookings IS 'Paid bookings for Adventure Cruises. Created by the Stripe webhook on checkout.session.completed. assigned_boat is null until the captain marks the manifest the morning of the sail.';
COMMENT ON TABLE adventure_cruises.cap_overrides IS 'the captain''s per-departure capacity overrides. Default cap is 80 (both boats). Override to 40 to run a single boat that slot; override to 0 to cancel the slot entirely. Absence of a row = use default 80.';
COMMENT ON TABLE adventure_cruises.enquiries IS 'Customer enquiries for Adventure Cruises day tour. Each row = one party of N seats for one (date, slot). RLS enabled, no policies = service-role-only access (engine code uses service_role server-side).';
COMMENT ON TABLE adventure_cruises.login_codes IS 'Short-lived 6-digit captain dashboard sign-in codes. SHA-256 hashed. 15-min expiry. Single-use. 5-attempt brute-force cap. Replaces broken magic-link auth that was mangled by Outlook ATP.';
COMMENT ON TABLE adventure_cruises.schedule_rules IS 'Recurring schedule patterns for Adventure Cruises (weekly blackouts, season windows). Layered ABOVE cap_overrides which handles ad-hoc per-(date,slot) blocks. Read by check_schedule_rules() helper.';
COMMENT ON TABLE adventure_cruises.waitlist IS 'Customers added when a (date, slot) is at cap. If a confirmed booking cancels, the first waitlist row in position order is notified.';
COMMENT ON TABLE public.login_codes IS 'Short-lived 6-digit captain dashboard sign-in codes for Bandama. See adventure_cruises.login_codes for full notes.';

-- test_charter: the hidden test operator, same shape as a one-boat charter
CREATE TABLE test_charter.bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  charter_date date NOT NULL,
  party_size integer NOT NULL,
  tour_option text,
  deposit_paid_cents integer NOT NULL,
  balance_due_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  stripe_charge_id text,
  status text DEFAULT 'booked'::text NOT NULL,
  cancelled_at timestamp with time zone,
  cancelled_reason text,
  refund_amount_cents integer DEFAULT 0 NOT NULL,
  refund_processed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE test_charter.captain_pins (
  email text NOT NULL,
  pin_hash text NOT NULL,
  pin_salt text NOT NULL,
  must_change boolean DEFAULT true NOT NULL,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE test_charter.enquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  preferred_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  charter_price_cents integer NOT NULL,
  deposit_amount_cents integer NOT NULL,
  currency text DEFAULT 'EUR'::text NOT NULL,
  status text DEFAULT 'received'::text NOT NULL,
  captain_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text) NOT NULL,
  captain_action_at timestamp with time zone,
  captain_note text,
  stripe_payment_link_id text,
  stripe_payment_link_url text,
  stripe_payment_intent_id text,
  stripe_link_expires_at timestamp with time zone,
  paid_at timestamp with time zone,
  source text DEFAULT 'web'::text,
  user_agent text,
  referrer text,
  ip_hash text,
  terms_accepted_at timestamp with time zone,
  terms_version text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  archived_at timestamp with time zone,
  archive_reason text
);
CREATE TABLE test_charter.waitlist (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enquiry_id uuid NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  requested_date date NOT NULL,
  alt_dates text,
  party_size integer NOT NULL,
  message text,
  tour_option text,
  status text DEFAULT 'waiting'::text NOT NULL,
  "position" integer NOT NULL,
  notification_token text DEFAULT encode(gen_random_bytes(24), 'hex'::text),
  notified_at timestamp with time zone,
  notification_expires_at timestamp with time zone,
  converted_to_enquiry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE OR REPLACE FUNCTION test_charter.is_date_taken(p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  return exists (
    select 1 from test_charter.bookings
    where charter_date = p_date and status in ('booked','completed')
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION test_charter.next_waitlist_position(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $function$
declare next_pos int;
begin
  select coalesce(max(position),0)+1 into next_pos
  from test_charter.waitlist
  where requested_date = p_date and status in ('waiting','notified');
  return next_pos;
end;
$function$
;
CREATE OR REPLACE FUNCTION test_charter.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
ALTER TABLE test_charter.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
ALTER TABLE test_charter.bookings ADD CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['booked'::text, 'completed'::text, 'cancelled'::text, 'refunded'::text, 'no_show'::text])));
ALTER TABLE test_charter.captain_pins ADD CONSTRAINT captain_pins_pkey PRIMARY KEY (email);
ALTER TABLE test_charter.enquiries ADD CONSTRAINT enquiries_captain_token_key UNIQUE (captain_token);
ALTER TABLE test_charter.enquiries ADD CONSTRAINT enquiries_party_size_check CHECK (((party_size >= 1) AND (party_size <= 20)));
ALTER TABLE test_charter.enquiries ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);
ALTER TABLE test_charter.enquiries ADD CONSTRAINT enquiries_status_check CHECK ((status = ANY (ARRAY['received'::text, 'confirmed'::text, 'paid'::text, 'declined'::text, 'expired'::text, 'cancelled'::text])));
ALTER TABLE test_charter.waitlist ADD CONSTRAINT waitlist_notification_token_key UNIQUE (notification_token);
ALTER TABLE test_charter.waitlist ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);
ALTER TABLE test_charter.waitlist ADD CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'notified'::text, 'converted'::text, 'expired'::text, 'released'::text])));
ALTER TABLE test_charter.bookings ADD CONSTRAINT bookings_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES test_charter.enquiries(id) ON DELETE RESTRICT;
ALTER TABLE test_charter.waitlist ADD CONSTRAINT waitlist_converted_to_enquiry_id_fkey FOREIGN KEY (converted_to_enquiry_id) REFERENCES test_charter.enquiries(id);
ALTER TABLE test_charter.waitlist ADD CONSTRAINT waitlist_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES test_charter.enquiries(id) ON DELETE RESTRICT;
CREATE INDEX bok_archived_uc ON test_charter.bookings USING btree (archived_at);
CREATE INDEX enq_archived_uc ON test_charter.enquiries USING btree (archived_at);
CREATE INDEX idx_uc_bookings_charter_date ON test_charter.bookings USING btree (charter_date);
CREATE INDEX idx_uc_bookings_enquiry_id ON test_charter.bookings USING btree (enquiry_id);
CREATE UNIQUE INDEX idx_uc_bookings_one_active_per_date ON test_charter.bookings USING btree (charter_date) WHERE (status = ANY (ARRAY['booked'::text, 'completed'::text]));
CREATE INDEX idx_uc_bookings_status ON test_charter.bookings USING btree (status);
CREATE INDEX idx_uc_enquiries_captain_token ON test_charter.enquiries USING btree (captain_token);
CREATE INDEX idx_uc_enquiries_created_at ON test_charter.enquiries USING btree (created_at DESC);
CREATE INDEX idx_uc_enquiries_customer_email ON test_charter.enquiries USING btree (customer_email);
CREATE INDEX idx_uc_enquiries_preferred_date ON test_charter.enquiries USING btree (preferred_date);
CREATE INDEX idx_uc_enquiries_status ON test_charter.enquiries USING btree (status);
CREATE INDEX idx_uc_waitlist_position ON test_charter.waitlist USING btree (requested_date, "position");
CREATE INDEX idx_uc_waitlist_req_date_status ON test_charter.waitlist USING btree (requested_date, status);
CREATE INDEX idx_uc_waitlist_status ON test_charter.waitlist USING btree (status);
CREATE TRIGGER trg_uc_bookings_updated_at BEFORE UPDATE ON test_charter.bookings FOR EACH ROW EXECUTE FUNCTION test_charter.set_updated_at();
CREATE TRIGGER trg_uc_enquiries_updated_at BEFORE UPDATE ON test_charter.enquiries FOR EACH ROW EXECUTE FUNCTION test_charter.set_updated_at();
CREATE TRIGGER trg_uc_waitlist_updated_at BEFORE UPDATE ON test_charter.waitlist FOR EACH ROW EXECUTE FUNCTION test_charter.set_updated_at();
ALTER TABLE test_charter.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_charter.captain_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_charter.enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_charter.waitlist ENABLE ROW LEVEL SECURITY;
comment on schema test_charter is 'Hidden test operator. Made-up data only. Never real customers.';

-- access: server key only
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema adventure_cruises from anon, authenticated;
revoke all on all functions in schema adventure_cruises from public, anon, authenticated;
grant usage on schema adventure_cruises to service_role;
grant all on all tables in schema adventure_cruises to service_role;
grant execute on all functions in schema adventure_cruises to service_role;
alter default privileges in schema adventure_cruises revoke all on tables from anon, authenticated;
alter default privileges in schema adventure_cruises revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema unexpected_charters from anon, authenticated;
revoke all on all functions in schema unexpected_charters from public, anon, authenticated;
grant usage on schema unexpected_charters to service_role;
grant all on all tables in schema unexpected_charters to service_role;
grant execute on all functions in schema unexpected_charters to service_role;
alter default privileges in schema unexpected_charters revoke all on tables from anon, authenticated;
alter default privileges in schema unexpected_charters revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema catamaran from anon, authenticated;
revoke all on all functions in schema catamaran from public, anon, authenticated;
grant usage on schema catamaran to service_role;
grant all on all tables in schema catamaran to service_role;
grant execute on all functions in schema catamaran to service_role;
alter default privileges in schema catamaran revoke all on tables from anon, authenticated;
alter default privileges in schema catamaran revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema test_charter from anon, authenticated;
revoke all on all functions in schema test_charter from public, anon, authenticated;
grant usage on schema test_charter to service_role;
grant all on all tables in schema test_charter to service_role;
grant execute on all functions in schema test_charter to service_role;
alter default privileges in schema test_charter revoke all on tables from anon, authenticated;
alter default privileges in schema test_charter revoke execute on functions from public, anon, authenticated;
commit;