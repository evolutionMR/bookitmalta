# BookItMalta — Execution Handoff
_Run by Claude · 2026-04-20_

This file tracks what was executed, what is waiting on Julian, and exactly what to do next.
The project lives at `~/Claude/bookitmalta/` on your computer (same folder this file is in).

---

## Status summary

| Phase | Status | Next action owner |
|------|------|------|
| 1 — Repo + initial commit | Done (local) | Julian (push to GitHub) |
| 2 — Vercel deploy | Blocked on push | Julian |
| 3 — DNS + SSL | Blocked on Vercel | Julian |
| 4 — Formspree | Needs form IDs | Julian → Claude |
| 5 — sitemap/robots (partial); GSC + Clarity | Needs GSC token + Clarity script | Julian → Claude |
| 6 — OG image + favicon | Needs design source files | Julian → Claude |
| 7.1 — WHOIS done; 7.2–7.4 La Zingara | Findings captured below | Julian |

---

## What Claude completed (Phase 1 + Phase 5 partial)

Inside `~/Claude/bookitmalta/` these files now exist and are committed to a local git repo on branch `main`:

- `index.html` — the landing page (unchanged; placeholders `REPLACE_WITH_GSC_TOKEN`, `REPLACE_WITH_FORMSPREE_ID`, `REPLACE_WITH_TRAVELLER_FORMSPREE_ID` still present)
- `BUILD_INSTRUCTIONS.md` — the full brief you uploaded
- `README.md`
- `.gitignore`
- `sitemap.xml` — single URL, lastmod 2026-04-20
- `robots.txt` — Allow all + sitemap pointer

First commit hash: `d7b6d49` — "Initial: landing page v1 + build brief + sitemap + robots"

⚠️ The commit author was set to `Julian Vella <julianvella15@gmail.com>` so the history looks right on GitHub. If you want different authorship, run `git commit --amend --reset-author` after configuring your local git identity.

---

## Phase 1.4 — push to GitHub (your turn)

Run this in your terminal from `~/Claude/bookitmalta/`:

```bash
cd ~/Claude/bookitmalta

# Option A: gh CLI (preferred — creates repo and pushes in one step)
gh repo create evolutionMR/bookitmalta --public --source=. --push \
  --description "BookItMalta landing page"

# Option B: if the repo already exists on github.com (created manually)
git remote add origin git@github.com:evolutionMR/bookitmalta.git
git push -u origin main
```

Validation: visit `https://github.com/evolutionMR/bookitmalta` — files should be there.

---

## Phase 2 — Vercel deploy (your turn)

Dashboard path (simpler):
1. vercel.com/new → Import `evolutionMR/bookitmalta`
2. Framework Preset: **Other** · Build Command: _empty_ · Output Directory: _empty_
3. Deploy
4. Copy the generated `*.vercel.app` URL and send it to me — I'll sanity-check it.

CLI path (if you have `vercel` logged in under the TrueNorthDigital team):
```bash
cd ~/Claude/bookitmalta
vercel link --project bookitmalta --yes
vercel --prod
```

---

## Phase 3 — DNS + SSL (your turn)

**In Vercel** (Project → Settings → Domains):
- Add `bookitmalta.com`
- Add `www.bookitmalta.com` → configure www-to-apex redirect

**In Cloudflare** (bookitmalta.com → DNS → Records). Delete any existing A/CNAME on `@` and `www` first, then add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | @ | `76.76.21.21` | **DNS only (grey cloud)** |
| CNAME | www | `cname.vercel-dns.com` | **DNS only (grey cloud)** |

Grey cloud is critical — orange cloud breaks Vercel's SSL.

Then wait 2–15 min and check `https://bookitmalta.com` in a browser. Ping me when resolved — I'll poll it and verify.

---

## Phase 4 — Formspree (your turn, then mine)

1. Sign up at formspree.io (`hello@bookitmalta.com` or fallback to your personal email — Zoho isn't live yet per the brief)
2. Create two forms:
   - **BookItMalta Operators** → notify `hello@bookitmalta.com`
   - **BookItMalta Travellers** → notify same
3. Copy both endpoint IDs (look like `xabcdefg`)
4. Send both IDs to me in chat — I'll sed-replace the two placeholders in `index.html`, commit, and push.

Also: once forms are created, go to each form's settings → **Allowed Domains** → add `bookitmalta.com` (and the `*.vercel.app` URL for testing). This avoids 403s later.

---

## Phase 5 — GSC + Clarity (your turn, then mine)

Google Search Console:
1. search.google.com/search-console → Add property → URL prefix `https://bookitmalta.com`
2. Select "HTML tag" method → copy the `content="..."` token → send it to me
3. After my commit + Vercel redeploy (~30s), click **Verify** in Search Console
4. Submit sitemap: `https://bookitmalta.com/sitemap.xml`

Microsoft Clarity:
1. clarity.microsoft.com → New project "BookItMalta" (separate from La Zingara)
2. Copy the tracking script (the `<script>` block)
3. Send it to me — I'll paste it immediately before `</head>`, commit, push.

---

## Phase 6 — OG image + favicon (your turn, then mine)

Produce in Canva (or equivalent):
- `og-image.jpg` — 1200×630, under 200 KB. BookItMalta wordmark in Fraunces italic, navy `#0B2545`, cream `#F4EBD9` background, tagline "Malta's direct-booking platform for boat charters", terracotta `#C85C2E` accent.
- Favicon source — 512×512 square "BM" monogram on cream.

Drop both into `~/Claude/bookitmalta/` and tell me; I'll generate the full favicon set and add the `<link rel="icon">` tags to `index.html`.

---

## Phase 7 — La Zingara cleanup (WHOIS done; rest on you)

### 7.1 — WHOIS findings for `catamaranmaltacharters.com`

- **Registrar:** Hostinger operations UAB
- **Created:** 2025-02-08 · **Expires:** 2027-02-08
- **Host:** Hostinger (LiteSpeed) — the site is a **live WordPress install**, not a parked page. The `/wp-json/` API is publicly reachable.
- **Current response:** `HTTP 200` — serves a real page.

So whoever at La Zingara registered the domain has a Hostinger hPanel account **and** a WordPress admin. Either is enough to implement the 301 redirect.

### 7.2 — 301 redirect options, in order of preference

1. **WordPress Redirection plugin** (easiest, reversible)
   - wp-admin → Plugins → Add New → "Redirection" by John Godley → Install/Activate
   - Tools → Redirection → Add: Source URL `/.*` (Regex), Target URL `https://catamaranmalta.com/`, HTTP code 301. Save.
2. **`.htaccess`** (Hostinger File Manager → `public_html/.htaccess`)
   ```
   RewriteEngine On
   RewriteCond %{HTTP_HOST} ^(www\.)?catamaranmaltacharters\.com$ [NC]
   RewriteRule ^(.*)$ https://catamaranmalta.com/$1 [R=301,L]
   ```
3. **Hostinger hPanel domain forwarder** (Websites → Domains → Forwarding) — point `catamaranmaltacharters.com` → `https://catamaranmalta.com/`, type 301.
4. Last resort: don't renew in Feb 2027.

Verify after 24h with `curl -I https://catamaranmaltacharters.com` — should return `301` with `Location: https://catamaranmalta.com/`.

### 7.3 — Google Business Profile

Only you can do this (ID verification). Details in Phase 7.3 of the brief — name "La Zingara Catamaran Charters", category Boat Charter Service, phone +356 99934881, website `https://catamaranmalta.com`.

### 7.4 — Facebook page rebrand to BookItMalta

Per the earlier Facebook update brief — rename page, username `@bookitmalta`, website link, cover + profile photo, five seed posts over two weeks.

---

## Unblocking order (shortest path to live site)

For the fastest path to `https://bookitmalta.com` being reachable:

1. Push to GitHub (5 min)
2. Import into Vercel (5 min) — site live at `*.vercel.app`
3. Add custom domain + Cloudflare DNS (2–15 min for SSL)
4. Everything else (forms, GSC, Clarity, OG image, La Zingara cleanup) is parallel and can wait a day or two without blocking traffic.

Total to a live, SSL'd `bookitmalta.com`: ~30 min once you're at a keyboard.

---

## What I will do when you come back

Tell me which of these you've done and I'll pick up:

- "Pushed to GitHub" → I'll note the remote URL is live.
- "Vercel URL is X, domain wired" → I'll curl-check SSL + all pages.
- "Formspree IDs: OP=xxxx TR=yyyy" → I'll sed-replace, commit, push.
- "GSC token: abc123" → I'll sed-replace, commit, push.
- "Clarity script: <script>...</script>" → I'll insert it and push.
- "OG image + favicon source dropped in the folder" → I'll generate the icon set and add the link tags.
