# BookItMalta — Build & Deployment Brief

**Version 1.0 · April 2026 · Prepared by Claude for TrueNorthDigital**

This document is the single source of truth for shipping the BookItMalta landing page and getting its surrounding digital infrastructure live. It is written to be executable by an AI agent (Cowork or equivalent) alongside manual steps performed by Julian.

---

## Prompt for Cowork (or equivalent agent)

If handing this off to Cowork, paste the following prompt to kick off the work:

> You are executing the build and deployment brief for BookItMalta, a new local-booking platform. Read `BUILD_INSTRUCTIONS.md` in this folder top to bottom before taking any action. Execute each phase in order. Before starting each phase, confirm you have the credentials or access listed under "Prerequisites". For steps marked **[MANUAL]**, stop and hand back to Julian with a clear summary of what you need. For steps marked **[AUTOMATED]**, execute and report the outcome. Do not skip validation steps. Report back at the end of each phase before moving to the next.

---

## What's in this delivery

Three files are handed to Cowork in the outputs folder:

| File | Purpose | Deployment destination |
|---|---|---|
| `index.html` | BookItMalta landing page (single-file, no build step) | Vercel → `bookitmalta.com` |
| `la-zingara-snapshot.docx` | Internal doc for Julian's meeting with La Zingara | Not deployed — Julian's desktop only |
| `bookitmalta-operator-agreement-template.docx` | Operator contract template | Not deployed — Julian's Google Drive |

Only `index.html` needs shipping. The two .docx files stay with Julian.

---

## Prerequisites (collect before starting)

Julian provides the following before Cowork begins. Each item is a blocker if missing.

### Accounts Julian must already have

- **GitHub account** — for the `bookitmalta` repository
- **Vercel account** — for deployment (the TrueNorthDigital team account per memory)
- **Cloudflare Registrar account** — domain `bookitmalta.com` already purchased here
- **Google account** — for Search Console and Business Profile
- **Microsoft Clarity account** — already in use for La Zingara per memory; create a new project for BookItMalta

### Accounts Cowork can help Julian set up

- **Formspree account** — free tier, for the two form endpoints
- **Canva or equivalent** — for OG image production (optional; can also be done in other tools)

### Information Julian must provide to Cowork

- GitHub username and access method (SSH key, personal access token, or GitHub CLI auth)
- Vercel CLI access or team-level API token
- Formspree login — or authorization for Cowork to create an account on his behalf
- Business contact email: `hello@bookitmalta.com` (in Zoho Mail setup per memory)

---

## Phase 1 — Repository setup

**Outcome:** A new public GitHub repo `evolutionMR/bookitmalta` containing `index.html` and this brief, committed and pushed.

### Step 1.1 — Create working directory **[AUTOMATED]**

```bash
mkdir -p ~/Projects/bookitmalta
cd ~/Projects/bookitmalta
```

### Step 1.2 — Copy files into working directory **[AUTOMATED]**

Copy `index.html` and `BUILD_INSTRUCTIONS.md` from the outputs folder into the working directory. Do not copy the two .docx files.

### Step 1.3 — Initialize git and first commit **[AUTOMATED]**

```bash
git init
git branch -M main

cat > .gitignore << 'EOF'
.DS_Store
node_modules/
.vercel
*.log
EOF

cat > README.md << 'EOF'
# BookItMalta

Malta's direct-booking platform for boat charters and sea experiences.
Launching Summer 2026.

See `BUILD_INSTRUCTIONS.md` for deployment details.
EOF

git add .
git commit -m "Initial: landing page v1 + build brief"
```

### Step 1.4 — Create remote repo on GitHub **[AUTOMATED with gh CLI, else MANUAL]**

If GitHub CLI is authenticated:

```bash
gh repo create bookitmalta --public --source=. --push --description "BookItMalta landing page"
```

Otherwise Julian creates the repo manually on github.com (owner: `evolutionMR`, name: `bookitmalta`, public, empty) and Cowork then pushes:

```bash
git remote add origin git@github.com:evolutionMR/bookitmalta.git
git push -u origin main
```

### Validation

- Visit `https://github.com/evolutionMR/bookitmalta` — files should be visible
- Clone URL should work

---

## Phase 2 — Vercel deployment

**Outcome:** The landing page is live at a `*.vercel.app` subdomain, auto-deploying from the GitHub repo.

### Step 2.1 — Import project to Vercel **[MANUAL by Julian, or AUTOMATED if Vercel CLI is authenticated]**

If Vercel CLI is authenticated under the TrueNorthDigital team:

```bash
cd ~/Projects/bookitmalta
vercel link --project bookitmalta --yes
vercel --prod
```

Otherwise Julian does this via the Vercel dashboard:

1. Go to vercel.com/new
2. Import the `evolutionMR/bookitmalta` repository
3. Framework Preset: **Other** (no build step)
4. Root Directory: `./`
5. Build Command: leave empty
6. Output Directory: leave empty
7. Deploy

### Step 2.2 — Capture the production URL **[AUTOMATED]**

Record the generated URL (will look like `https://bookitmalta-xxx-truenorthdigitals-projects.vercel.app`). This is the source of truth for DNS in Phase 3.

### Validation

- Visit the `*.vercel.app` URL — landing page should render
- Check in browser dev tools that no console errors appear
- Verify responsive behavior at 375px, 768px, 1280px widths

---

## Phase 3 — Custom domain configuration

**Outcome:** `bookitmalta.com` and `www.bookitmalta.com` resolve to the Vercel deployment with valid SSL.

### Step 3.1 — Add domain in Vercel **[MANUAL by Julian]**

Vercel dashboard → Project → Settings → Domains:

1. Add `bookitmalta.com`
2. Add `www.bookitmalta.com` (configure www → apex redirect)
3. Vercel displays the DNS records required

### Step 3.2 — Configure Cloudflare DNS **[MANUAL by Julian]**

Cloudflare Dashboard → bookitmalta.com → DNS → Records:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | @ | `76.76.21.21` | DNS only (grey cloud) |
| CNAME | www | `cname.vercel-dns.com` | DNS only (grey cloud) |

**Important:** Set proxy status to "DNS only" (grey cloud), not "Proxied" (orange cloud). Vercel handles SSL; Cloudflare proxying interferes with it.

### Step 3.3 — Wait for SSL provisioning **[AUTOMATED monitoring]**

Cowork polls `https://bookitmalta.com` every 60 seconds until it returns 200 OK with a valid certificate. Typical time: 2–5 minutes. Max wait: 15 minutes. If still failing, hand back to Julian.

### Validation

- `curl -I https://bookitmalta.com` returns 200
- `curl -I https://www.bookitmalta.com` returns 200 or 301 to apex
- Browser shows valid SSL padlock
- Landing page renders identically to the `*.vercel.app` URL

---

## Phase 4 — Form wiring (Formspree)

**Outcome:** Both operator and traveller forms submit to live Formspree endpoints. Julian receives email notifications on submission.

### Step 4.1 — Create Formspree account and forms **[MANUAL with Cowork browser automation possible]**

1. Sign up at formspree.io with `hello@bookitmalta.com`
2. Create form #1: name it **"BookItMalta Operators"**, notify address `hello@bookitmalta.com` (or Julian's personal email until Zoho is live)
3. Create form #2: name it **"BookItMalta Travellers"**, same notify address
4. Record both form endpoint IDs (will look like `xabcdefg`)

### Step 4.2 — Replace placeholders in index.html **[AUTOMATED]**

In the working directory, run:

```bash
# Replace with the actual IDs from Formspree
OP_FORM_ID="xabc1234"
TR_FORM_ID="xdef5678"

sed -i.bak "s/REPLACE_WITH_FORMSPREE_ID/$OP_FORM_ID/g" index.html
sed -i.bak "s/REPLACE_WITH_TRAVELLER_FORMSPREE_ID/$TR_FORM_ID/g" index.html
rm index.html.bak
```

Verify the replacement:

```bash
grep -n "REPLACE_WITH" index.html || echo "All placeholders replaced."
grep -n "formspree.io/f/" index.html
```

### Step 4.3 — Commit and redeploy **[AUTOMATED]**

```bash
git add index.html
git commit -m "Wire Formspree form endpoints"
git push
```

Vercel auto-deploys within 30–60 seconds.

### Step 4.4 — Test both forms **[AUTOMATED]**

Submit a test entry to each form with identifiable test data (e.g. name: "Test Submission", company: "COWORK TEST"). Verify:

- The inline success message appears in the browser
- Julian receives the submission notification by email
- The submission appears in the Formspree dashboard

Delete the test submissions from the Formspree dashboard after verifying.

### Validation

- Operator form submits without page reload
- Traveller form submits without page reload
- Both display the green success message inline
- Julian confirms receipt of both test emails

---

## Phase 5 — Analytics & SEO foundation

**Outcome:** Google Search Console verified, Microsoft Clarity tracking active, sitemap submitted.

### Step 5.1 — Google Search Console verification **[MANUAL by Julian]**

Cowork cannot log in to Julian's Google account. Julian does this:

1. search.google.com/search-console
2. Add property → URL prefix → `https://bookitmalta.com`
3. Select "HTML tag" verification method
4. Copy the `content="..."` value
5. Send the value to Cowork

Cowork then:

```bash
# Replace placeholder with the real token from Julian
GSC_TOKEN="abc123def456"
sed -i.bak "s/REPLACE_WITH_GSC_TOKEN/$GSC_TOKEN/g" index.html
rm index.html.bak
git add index.html
git commit -m "Add Google Search Console verification tag"
git push
```

Wait for Vercel to redeploy (~30s), then Julian clicks "Verify" in Search Console.

### Step 5.2 — Microsoft Clarity integration **[SEMI-AUTOMATED]**

Julian creates a new Clarity project at clarity.microsoft.com named "BookItMalta" (separate from the La Zingara project already in use) and provides Cowork with the tracking script. Cowork inserts it immediately before the closing `</head>` tag in `index.html`, commits, pushes.

### Step 5.3 — Create basic sitemap **[AUTOMATED]**

Since the site currently has one page, create `sitemap.xml` in the repo root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://bookitmalta.com/</loc>
    <lastmod>2026-04-20</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

And `robots.txt`:

```
User-agent: *
Allow: /

Sitemap: https://bookitmalta.com/sitemap.xml
```

Commit and push.

### Step 5.4 — Submit sitemap to Search Console **[MANUAL by Julian]**

In Search Console → Sitemaps → submit `https://bookitmalta.com/sitemap.xml`.

### Validation

- Search Console shows "Ownership verified"
- Clarity dashboard shows traffic within 5–10 minutes of a test visit
- `https://bookitmalta.com/sitemap.xml` returns valid XML
- `https://bookitmalta.com/robots.txt` returns the file

---

## Phase 6 — Asset production (OG image, favicon)

**Outcome:** Professional social-share image and favicon in place.

### Step 6.1 — OG image **[MANUAL by Julian]**

Cowork cannot produce design assets. Julian creates a 1200×630px image in Canva with:

- BookItMalta wordmark in Fraunces italic, navy `#0B2545`
- Tagline: *"Malta's direct-booking platform for boat charters"*
- Background: Mediterranean cream `#F4EBD9` or a dark-overlay photo of Malta coast
- Small terracotta accent `#C85C2E`

Save as `og-image.jpg` (JPG, under 200 KB). Hand back to Cowork.

### Step 6.2 — Favicon **[MANUAL by Julian, SEMI-AUTOMATED generation]**

Julian produces a 512×512px square "BM" monogram on cream background. Cowork can then auto-generate the favicon set using a service like realfavicongenerator.net, or manually:

```bash
# Requires ImageMagick
convert source-512.png -resize 32x32 favicon-32.png
convert source-512.png -resize 16x16 favicon-16.png
convert source-512.png -resize 180x180 apple-touch-icon.png
convert favicon-32.png favicon-16.png favicon.ico
```

### Step 6.3 — Place assets and reference them **[AUTOMATED]**

Move assets into the repo root:

```
bookitmalta/
├── index.html
├── og-image.jpg
├── favicon.ico
├── favicon-32.png
├── favicon-16.png
├── apple-touch-icon.png
├── sitemap.xml
├── robots.txt
└── BUILD_INSTRUCTIONS.md
```

Add favicon references to `<head>` in `index.html` (immediately after the title block):

```html
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
```

Commit, push, wait for deploy.

### Validation

- Visit `https://bookitmalta.com/og-image.jpg` → image displays
- Visit `https://bookitmalta.com/favicon.ico` → icon downloads
- Browser tab shows the favicon
- Paste `https://bookitmalta.com` into iMessage / WhatsApp / LinkedIn preview → correct image and text display

---

## Phase 7 — La Zingara-specific cleanup

**Outcome:** catamaranmaltacharters.com stops competing with catamaranmalta.com for La Zingara's brand searches. Google Business Profile claimed.

### Step 7.1 — Identify who controls catamaranmaltacharters.com **[MANUAL by Julian]**

Julian checks with La Zingara's owner who holds the registration and hosting for catamaranmaltacharters.com. Cowork can run a WHOIS lookup for hints:

```bash
whois catamaranmaltacharters.com | grep -iE "registrar|registrant|name server"
```

Results go back to Julian.

### Step 7.2 — 301 redirect or take down **[MANUAL, potentially with Cowork help]**

Preferred: 301 redirect the entire domain to `https://catamaranmalta.com/`. Method depends on where the old site is hosted (likely a shared WordPress host given its appearance). Options in order of preference:

1. **WordPress still accessible:** install the `Redirection` plugin or edit `.htaccess` to add a wildcard 301 redirect to catamaranmalta.com
2. **Hosting panel accessible:** configure domain-level redirect via cPanel / hosting control panel
3. **DNS-only:** add a CNAME from catamaranmaltacharters.com to catamaranmalta.com — less clean but works
4. **Last resort:** let domain expire and ensure it is not renewed

Whichever method is used, Julian verifies after 24 hours that `curl -I https://catamaranmaltacharters.com` returns 301 to catamaranmalta.com.

### Step 7.3 — Google Business Profile claim **[MANUAL by Julian]**

Cowork cannot perform identity verification. Julian:

1. google.com/business → Add your business
2. Business name: "La Zingara Catamaran Charters"
3. Category: Boat Charter Service
4. Location: Sliema, Malta (dock location)
5. Service area: Malta, Gozo, Comino
6. Phone: +356 99934881
7. Website: https://catamaranmalta.com
8. Verification: postcard (2–5 days) or video verification if available

Once verified, Julian adds photos (use Sanity CDN photos from catamaranmalta.com), business hours, and a description.

### Step 7.4 — Facebook page copy + visual update **[MANUAL by Julian]**

Reference the Facebook update brief from earlier in the conversation. Key updates:
- Page name: `BookItMalta`
- Username: `@bookitmalta` (if available)
- Website link: `https://bookitmalta.com`
- About: per previously drafted copy
- Cover photo: per the 1640×624 spec
- Profile photo: per the 500×500 spec
- Post the five seed posts over two weeks

### Validation

- `curl -I https://catamaranmaltacharters.com` returns 301 (once redirect is live)
- Google Business Profile status shows "Verified"
- Facebook page shows new wordmark, cover, about section, and link to bookitmalta.com

---

## Phase 8 — Post-launch monitoring (first 7 days)

**Outcome:** Julian has visibility on what's happening once the site is live.

### Daily checks for week 1

- Vercel Analytics → pageviews, referrers
- Microsoft Clarity → session recordings, heatmaps
- Google Search Console → coverage, any errors
- Formspree dashboard → any new submissions
- Manual brand search: Google "BookItMalta" — check how Google indexes the site

### Weekly checks for month 1

- Search Console → impressions and clicks trending
- Any operator submissions that arrived — Julian responds within 48 hours per the landing page commitment
- Traffic coming through the La Zingara UTM (`?utm_source=bookitmalta`) → indicates the referral flow is working

---

## Appendix A — What Cowork can and cannot do

### Cowork can handle autonomously
- Creating the working directory, files, and repository
- Running git, gh, Vercel CLI commands
- Editing files with sed/grep/replacement
- Running WHOIS and curl checks
- Generating the sitemap and robots.txt
- Automating favicon generation from a source image (if ImageMagick or online service is available)
- Polling endpoints for SSL readiness

### Cowork cannot do (these need Julian)
- Logging into Julian's Google, Vercel, Cloudflare, or Facebook accounts
- Adding payment methods (Vercel Pro, Supabase Pro when time comes)
- Producing the OG image or favicon source design
- Claiming Google Business Profile (identity verification)
- Accessing the catamaranmaltacharters.com WordPress admin (credentials unknown)
- Making final judgment calls on copy or design changes

---

## Appendix B — Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| SSL error on bookitmalta.com after DNS change | Cloudflare proxy enabled | Set proxy status to "DNS only" (grey cloud) |
| Forms submit but no email arrives | Formspree awaiting email confirmation | Check inbox for Formspree verification email, confirm |
| Page loads but favicon missing | Cache | Hard-refresh browser; wait 5 minutes for CDN |
| OG image not showing on WhatsApp share | Cache | Use Facebook Debugger → Scrape Again to force refresh |
| Google Search Console verification fails | Tag not deployed yet | Wait 60 seconds for Vercel redeploy; retry |
| Formspree form 403 on submit | Domain not whitelisted | Add bookitmalta.com to the Formspree project settings |

---

## Appendix C — What happens after this brief is complete

After the brief is fully executed, the following remain as manual next steps for Julian:

1. **Send the snapshot document to La Zingara** (`la-zingara-snapshot.docx`) — 48 hours before the meeting
2. **Legal review of the operator agreement template** — book the Malta lawyer, use the checklist on the last page of the contract doc
3. **Begin operator target list** — research and list 30–40 Malta charter operators
4. **Begin organic SEO content work** — first long-form article for both bookitmalta.com and catamaranmalta.com
5. **Schedule the La Zingara meeting**

These are strategic steps that require Julian's judgment and relationships, not executable via Cowork.

---

**End of brief. Version 1.0 · April 2026.**
