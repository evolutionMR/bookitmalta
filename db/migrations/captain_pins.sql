-- captain_pins — PIN auth for the operator (captain) dashboard.
--
-- Run ONCE per tenant, inside that tenant's Postgres schema (the schema named
-- in config/tenants.js → tenant.schema: 'public' for Bandama,
-- 'adventure_cruises' for Adventure Cruises). Either set the search_path to the
-- tenant schema before running, or schema-qualify the table name.
--
-- PINs are stored only as a scrypt hash + per-PIN salt (see api/_lib/captain-auth.js).
-- RLS is enabled with NO policies, so only the service-role key (server-side)
-- can read or write — the anon key has zero access.

create table if not exists captain_pins (
  email           text primary key,
  pin_hash        text        not null,
  pin_salt        text        not null,
  must_change     boolean     not null default true,   -- force a change on first sign-in
  failed_attempts integer     not null default 0,
  locked_until    timestamptz,                          -- set after too many wrong tries
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table captain_pins enable row level security;
-- Intentionally no policies: service-role only.
