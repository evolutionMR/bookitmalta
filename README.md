# BookItMalta

Malta's direct-booking platform for boat charters and sea experiences.
Launching Summer 2026.

See `BUILD_INSTRUCTIONS.md` for deployment details.

## Repository layout

- `main` — production trunk. Vercel auto-deploys main to bookitmalta.com.
- Short-lived `feat/<topic>` and `fix/<topic>` branches off main are the standard flow: cut, push, open a PR, `@codex review`, merge. The auto-delete-on-merge setting cleans up the source branch automatically.

## Parked branches

- `feat/ia-flip-directory-homepage` — abandoned 2026-05-13 experiment that pivots the site away from the booking engine toward a hosted-directory model. Deletes `api/`, the DB migrations, `config/tenants.js`, and rewrites `index.html` end-to-end. **Do not merge into main** — it would unship the engine. Kept on origin as a parking lot in case specific files (e.g. `for-operators.html`, the catamaran-malta lander) are later cherry-picked as standalone PRs.
