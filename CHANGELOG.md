# Changelog

## 2026-06-17

### Adventure Cruises mobile hero pass (feat/ac-mobile-quickpick → main, f77e7f0)

Driven by Clarity data: on mobile, most paid visitors never reached the booking
widget. Root cause wasn't the booking flow (which is solid) — it was the hero
eating the whole first screen. A from-scratch redesign was explicitly rejected
because it would have dropped the booking backend, Google Ads conversion and SEO.
So this is a surgical, CSS+copy-only pass on the existing page; booking,
`/api/enquiry`, `bimTrackConversion`, consent and SEO were left untouched
(Julian confirmed tracking + booking 100% on preview before merge).

- Hero `min-height` 78vh→60vh (mobile) / 86vh→70vh (tablet) so the trust strip
  and booking surface sooner.
- Hero crop `object-position` 60% center → 50% 84% and scrim lightened up top
  so the boat in the turquoise lagoon is visible (was an all-navy panel).
- Hero lead paragraph hidden on mobile (shown ≥760px) — it was covering the
  boat; the same facts live in the trust strip directly below.
- Headline em set `white-space: nowrap` so "€40 a seat." stops orphaning "seat.".
- Secondary "See what's included" CTA hidden on mobile (shown ≥760px) — one
  clear "Check availability" instead of two stacked buttons.
- Copy honesty: dropped "you see real availability for the next 30 days" (no live
  seat data) → "Pick any departure … we confirm your seats within the hour".
- Balance-to-crew copy is cash-only (was "cash or by card" / "cash, card, or
  local payment apps"), per operator preference.

Net diff: ~12 lines of `adventure-cruises.html`. Shipped straight via prod-first
short branch → Vercel preview verified → ff-merge to main.
