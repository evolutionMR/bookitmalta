# BookItMalta — rules for anyone (or any agent) changing this code

BookItMalta (bookitmalta.com) is a marketing service for Malta boat operators with a
booking platform underneath. `main` is the live site. Vercel deploys every push to `main`.

The full release process and the facts about prices and operators are kept by the owner
outside this repo (in his Claude project). If you cannot see them, ask the owner. Do not guess.

## How a change ships
1. Never push to `main`. Work on a short-lived side branch (`feat/<topic>` or `fix/<topic>`).
2. Open a pull request. The "Site rules" check must pass
   (`python3 scripts/check-site-rules.py origin/main`).
3. Test on the Vercel preview at 390px wide. Never email a real captain or customer from a
   test. There is no test operator yet, so until one exists a booking change cannot be
   tested end to end by an agent: stop and tell the owner.
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
  from `config/tenants.js`, never from the request. Each tenant names its own Postgres
  schema there (the first tenant uses `public`; a quote-only listing has none).
- Every new Supabase table gets row level security switched on at once, with no policies
  unless public read is truly needed.
- Secrets live only in Vercel env vars, namespaced by tenant (`BANDAMA_*`,
  `ADVENTURE_CRUISES_*`). Never commit, print or log a secret. After changing an env var, redeploy.
- Never ship a placeholder operator email. Prove the inbox receives mail first.
- Resend does not throw on failure. Always check `result.error`.
- Magic links and email URLs should take their base URL from the request host (with an
  allowlist), not from a hard-coded env var. Known gap: `api/captain.js` still reads
  `PUBLIC_BASE_URL`. Do not copy that pattern into new code.
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
Vercel previews and in the "Site rules" check. The check counts old rule breaks per file
and fails only when a change adds one, so fix old ones a file at a time.

## Not public
This file, the notes, the database scripts and the tooling are kept off the public site by
`.vercelignore`. Anything new that is not a page, an asset or server code goes in there too.
