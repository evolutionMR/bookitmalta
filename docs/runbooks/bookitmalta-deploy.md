# Deploying a change to bookitmalta.com

**Frequency**: per change
**Estimated time**: 5–10 min
**Last run**: 2026-06-17 (AC mobile hero pass)
**Owner**: Julian

## Why this exists
The 2026-06-17 AC deploy hit three avoidable footguns that each cost time and
nearly broke prod. This runbook bakes in the fixes so the next ship is clean.

## The three footguns (read before deploying)

1. **bookitmalta is its own repo — NOT TrueNorthDigital.**
   The live site `bookitmalta.com` is the Vercel project `bookitmalta`, backed by
   GitHub `evolutionMR/bookitmalta`. `TrueNorthDigital` is the *catamaran* repo
   (`true-north-digital` project, catamaranmalta.com). Any generic deploy script
   that auto-detects `~/Documents/TrueNorthDigital` will point at the WRONG repo.
   → Always confirm `git config --get remote.origin.url` ends in `bookitmalta.git`
   before touching anything.

2. **Local `main` is often many commits behind origin/main.**
   Pushes happen from multiple clones (incl. an iCloud working copy). A stale
   local `main` + a pile of untracked image files makes `git pull` abort with
   "untracked working tree files would be overwritten". NEVER commit/push on a
   stale main — a force-push would wipe prod commits.
   → `git fetch && git status` first. If behind, stash untracked (`git stash -u`)
   then `git pull --ff-only`, then re-apply your change.

3. **iCloud creates conflict-copies (`… 2.jpg`, `… 3.webp`).**
   The clone under `~/Library/Mobile Documents/.../Claude/01_BookItMalta/workspace/bookitmalta`
   is iCloud-synced. Git churn there spawns duplicate untracked files and stale
   `.git/index.lock`s. Prefer a non-iCloud clone if one exists.
   → Clean dupes with `git clean -n <dir>` (preview) then `git clean -f <dir>`.

## Steps (prod-first short branch)
1. `cd` into the bookitmalta repo; confirm remote is `evolutionMR/bookitmalta`.
2. `git checkout main && git pull --ff-only` (resolve any stale-main blockers above).
3. `git checkout -b feat/<slug>` and make the change.
4. Commit, `git push -u origin feat/<slug>` → Vercel auto-builds a branch preview.
5. Verify on the preview URL `bookitmalta-git-<branch-trunc>-truenorthdigitals-projects.vercel.app`.
   Mobile-first: test at real phone width. The desktop browser may not render
   below ~1408px — render inside a 390px `<iframe>` to judge mobile.
6. For booking pages, confirm the `/api/enquiry` submit + `bimTrackConversion`
   still fire (the one check that matters — only Julian can trigger a real enquiry).
7. `git checkout main && git merge --ff-only feat/<slug> && git push origin main`.
8. Give prod ~1 min, verify on `bookitmalta.com/<route>`.

## Failure modes
- Push rejected (non-fast-forward) → local main is behind; pull --ff-only first.
- Preview shows a Vercel login wall → not signed into Vercel in that browser.
- Hero/gallery images 404 on a new page → assets must be committed in the same
  repo under `charters/<tenant>-images/` before deploy.
