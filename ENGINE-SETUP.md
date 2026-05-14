# BookItMalta Enquiry Engine — Setup Guide

> Phase 1 of the multi-tenant booking engine. Date: 2026-05-12.
> Branch: `feat/enquiry-engine-phase-1`.

The engine ships in *three* stages: (1) deploy the code on a feature branch
and verify the Vercel preview builds without errors; (2) wire up the
infrastructure (Supabase, Stripe, Resend); (3) cut the live tenant page
forms over from Formspree to `/api/enquiry`.

This doc walks through stage 2 and 3 — stage 1 happens automatically when
you run the deploy script.

---

## What the engine does

```
┌─────────────────┐
│ Tenant page     │
│ form submits    │
└────────┬────────┘
         │ POST /api/enquiry { tenant: 'bandama', ... }
         ▼
┌─────────────────────────────────────────────────────────┐
│ /api/enquiry                                            │
│   1. Validate input                                     │
│   2. Check `is_date_taken(preferred_date)` in Supabase  │
│      → if YES → route to waitlist                       │
│      → if NO  → route to enquiries                      │
│   3. Email captain (with confirm/decline magic links)   │
│   4. Email customer (ack — sets 24h expectation)        │
│   5. Redirect to /charters/<tenant>#enquiry-confirmed   │
└─────────────────────────────────────────────────────────┘
         │
         │  Captain receives email, clicks "CONFIRM"
         ▼
┌─────────────────────────────────────────────────────────┐
│ /api/captain?token=...&action=confirm                   │
│   1. Look up enquiry by token                           │
│   2. Create Stripe Payment Link (€300 deposit)          │
│   3. Email customer with link                           │
│   4. Mark enquiry → 'confirmed'                         │
└─────────────────────────────────────────────────────────┘
         │
         │  Customer clicks link, pays via Stripe Checkout
         ▼
┌─────────────────────────────────────────────────────────┐
│ Stripe → POST /api/stripe-webhook?tenant=bandama        │
│   1. Verify signature                                   │
│   2. Insert booking record (locks the date)             │
│   3. Mark enquiry → 'paid'                              │
│   4. Deactivate Payment Link (can't be paid twice)      │
│   5. Email customer: "you're booked"                    │
│   6. Email captain: "BOOKED — collect balance"          │
└─────────────────────────────────────────────────────────┘
```

---

## Setup steps (one-time per tenant)

### 1. Supabase project

Each tenant gets its own Supabase project. Bandama first.

1. Go to https://supabase.com/dashboard → New project.
2. Name: `bookitmalta-bandama`. Region: Frankfurt or London (EU). Strong password.
3. Wait for it to provision (~2 minutes).
4. Open the SQL Editor and paste the contents of
   `db/migrations/0001_init_enquiry_engine.sql`. Run it.
5. Go to **Project Settings → API** and copy:
   - `Project URL`            → env var `BANDAMA_SUPABASE_URL`
   - `service_role` secret    → env var `BANDAMA_SUPABASE_SERVICE_ROLE_KEY`
6. Confirm RLS is enabled on all three tables (Authentication → Policies).
   You should see "RLS enabled, 0 policies" — that's correct; only the
   service role can read/write.

### 2. Stripe (BookItMalta's existing account)

For Hosted Founding tenants like Bandama, the deposit IS our commission,
so payments go to BookItMalta's Stripe account. No Stripe Connect needed.

1. Stripe Dashboard → **Developers → API keys**
   - Copy the live secret key → env var `BANDAMA_STRIPE_SECRET_KEY`
2. **Developers → Webhooks → Add endpoint**
   - URL: `https://bookitmalta.com/api/stripe-webhook?tenant=bandama`
   - Events to send:
     - `checkout.session.completed`
     - `payment_intent.succeeded`
     - `charge.refunded`
     - `payment_intent.payment_failed`
   - Copy the **signing secret** (`whsec_...`) → env var
     `BANDAMA_STRIPE_WEBHOOK_SECRET`

When you onboard a tenant who wants deposits routed to their own Stripe
account (i.e. not a Hosted Founding tenant), we'll switch to Stripe Connect
Standard. That's a separate code path — not built yet.

### 3. Resend

Shared across tenants (one Resend account, one API key).

1. https://resend.com → **API Keys → Create**
   - Permission: Full access. Name: `bookitmalta-production`.
   - Copy → env var `RESEND_API_KEY`
2. **Domains → Add domain → bookitmalta.com**
   - Add the DNS records Resend gives you (in your domain registrar).
   - Wait for verification (usually <5 minutes).
3. Per-tenant from address (optional but recommended):
   - `BANDAMA_RESEND_FROM=Bandama Yacht Charters <noreply@bookitmalta.com>`

### 4. Vercel env vars

In the bookitmalta Vercel project, **Settings → Environment Variables**:

| Variable                              | Environment(s)        |
|---------------------------------------|-----------------------|
| `RESEND_API_KEY`                      | Production + Preview  |
| `BANDAMA_SUPABASE_URL`                | Production + Preview  |
| `BANDAMA_SUPABASE_SERVICE_ROLE_KEY`   | Production + Preview  |
| `BANDAMA_STRIPE_SECRET_KEY`           | Production + Preview  |
| `BANDAMA_STRIPE_WEBHOOK_SECRET`       | Production + Preview  |
| `BANDAMA_OPERATOR_EMAIL`              | Production + Preview  |
| `BANDAMA_RESEND_FROM`                 | Production + Preview  |
| `BANDAMA_PUBLIC_BASE_URL`             | Production + Preview  |

For preview/staging, use **test mode** Stripe keys (`sk_test_...`,
`whsec_test_...`) and a separate Supabase project (`bookitmalta-bandama-staging`).

### 5. Smoke test before flipping the form

After Vercel deploys the branch and you've set the env vars, smoke-test
the endpoint with curl:

```bash
# Enquiry (date should be free)
curl -X POST https://<your-preview>.vercel.app/api/enquiry \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "tenant": "bandama",
    "customer_name": "Test User",
    "customer_email": "you@yourtest.com",
    "customer_phone": "+356 9999 0000",
    "preferred_date": "2026-08-15",
    "alt_dates": "Aug 16-17",
    "party_size": 4,
    "message": "Smoke test — please ignore"
  }'
```

You should:
1. Receive a 200 JSON response with `{ "type": "enquiry", "status": "received", "enquiry_id": "..." }`
2. See an email arrive at `BANDAMA_OPERATOR_EMAIL` (the captain notification)
3. See an email arrive at the customer email (the ack)
4. See a row in the `enquiries` table in Supabase
5. Click the captain "CONFIRM" link → land on a styled HTML page → confirm
6. See a Stripe Payment Link email arrive at the customer email
7. Pay (test mode card: `4242 4242 4242 4242`)
8. See a "BOOKED" email arrive at both captain + customer
9. See a row in the `bookings` table with `status: 'booked'`

Once all 9 boxes tick, you're cleared to merge to main and proceed to stage 3.

### 6. Stage 3 — flip the live form

Once everything above is green, a small follow-up PR replaces the Formspree
`action="..."` on `charters/bandama/index.html` and `charters/adventure-cruises/index.html`
with `action="/api/enquiry"` and removes the Formspree hidden fields
(`_subject`, `_next`, `_format`). Done in a separate branch so a broken API
can't break the live form mid-build.

---

## Function count

This deploy adds 3 functions:

| Function              | Purpose                             |
|-----------------------|-------------------------------------|
| `api/enquiry.js`      | Form POST → enquiry or waitlist     |
| `api/captain.js`      | Magic-link review/confirm/decline   |
| `api/stripe-webhook.js`| Stripe payment notifications       |

Total: **3 / 12** of the Hobby plan limit. Plenty of headroom for the
next phase (multi-tenant captain portal, customer-facing date picker, etc.).

---

## What's not in this phase

- **Captain portal** (list view of all enquiries + bookings). Captain only
  has magic-link access to individual enquiries via email.
- **Customer-facing real date picker** that checks availability before submit.
  Currently the form takes a free-text "preferred date" string; we
  parse it server-side and route to waitlist if taken.
- **Auto-expiry** of confirmed-but-unpaid enquiries past `stripe_link_expires_at`.
  For Phase 1 we rely on the Stripe Payment Link's natural behaviour + manual
  cleanup. Phase 2 adds a Vercel cron.
- **Adventure Cruises** wiring. The tenant config exists; Stripe + Supabase
  for that operator aren't set up yet.
- **WhatsApp notification** to captain (currently email only).
- **Customer "claim waitlist slot" page** (the link is generated but
  `/api/waitlist-claim` isn't built yet — Phase 2).

These are all 1–2 day items each. Worth adding once Phase 1 has proven
itself with real customers.
