# BookItMalta — rules for anyone (or any agent) changing this code

BookItMalta (bookitmalta.com) is a marketing service for Malta boat operators with a
booking platform underneath. `main` is the live site. Vercel deploys every push to `main`.

The full process is in the Claude project doc `claude/release-process.md`.
Facts about prices and operators live in the project doc `business-facts.md`, not here.

## How a change ships
1. Never push to `main`. Work on a short-lived side branch (`feat/<topic>`, `fix/<topic>` or `auto/<topic>`).
2. Open a pull request. The "Site rules" check must pass (`scripts/check-site-rules.sh`).
3. Test on the Vercel preview at 390px wide. For booking changes, send a real test request
   using the test operator only. Never email a real captain or customer from a test.
4. Two independent reviews before merge: one reads the code, one checks the preview against what was agreed.
5. Changes to prices, deposits, payments, the database, who sees customer details, logins,
   settings, secrets, or anything sent to real people need the owner's yes before merge.
6. After merge, check the live page. Before saying a live page is broken, check the `age:` and
   `x-vercel-cache` headers. If a live check fails, roll back first, then investigate.

## Wording rules for public pages and customer emails
- Never name other booking platforms or competitors. Say "marketplaces" or "OTAs".
  The check script holds the exact list and it must find nothing.
- The money word is "deposit". Never "booking fee", and no flat fee range on generic pages.
- One all-in deposit figure. Never show card fees as a separate line.
- Name an operator only on its own listing page. On generic pages say "a Malta charter operator".
- The catamaran listing is "La Zingara & Chardonnay". Never "Catamaran Malta".
- Never name a skipper or captain. Say "the captain" or "your skipper".
- Never write "Stripe" in customer-facing copy. Say "secure payment link" or "pay by card".
  (It is fine on /for-operators.)
- The catamarans are bring-your-own food and drink. Never "catering".
- Every link to catamaranmalta.com carries `?utm_source=bookitmalta`.
- Microsoft Clarity loads through `consent.js`; every indexable page includes it.
- The footer names the business (TrueNorthDigital, trading as BookItMalta), its VAT exemption
  (Article 11) and its VAT number.
- No Trustpilot stars widget while there are no reviews.

## Code rules
- Vercel Hobby allows 12 serverless functions. Never add a new file directly under `/api`.
  Add a `mode` or `action` to an existing endpoint. Helpers go in `api/_lib/`.
- Tenants: the request may name the tenant, but the schema, prices and secrets always come
  from `config/tenants.js`, never from the request. One Postgres schema per tenant.
- Every new Supabase table gets row level security switched on at once, with no policies
  unless public read is truly needed.
- Secrets live only in Vercel env vars, namespaced by tenant (`BANDAMA_*`,
  `ADVENTURE_CRUISES_*`). Never commit, print or log a secret. After changing an env var, redeploy.
- Never ship a placeholder operator email. Prove the inbox receives mail first.
- Resend does not throw on failure. Always check `result.error`.
- Magic links and email URLs take their base URL from the request host (with an allowlist),
  never from a hard-coded env var.
- External webhooks to a preview URL need the Vercel protection-bypass token.
- BookItMalta never holds an operator's money. The deposit is BookItMalta's commission;
  the balance is paid to the operator on the day.
- Stripe today is BookItMalta's own account. Stripe Connect is not built.
- Never retry a paid API that returned a quota or auth error.
- No rate-parity clause in any operator agreement.
- Never merge or revive the parked branch `feat/ia-flip-directory-homepage`.
- This repo is only bookitmalta.com. The catamaranmalta.com site is a different repo.

## Testing
There is no local build step and no Node on the owner's Mac. Verification happens on
Vercel previews and in the "Site rules" check.
