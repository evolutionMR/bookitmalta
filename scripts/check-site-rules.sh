#!/usr/bin/env bash
# BookItMalta site-rule checks.
# Usage: bash scripts/check-site-rules.sh [base-ref]     (default base: origin/main)
# Compares the working tree against the base and fails if a rule is newly broken.
# Old breaks already on the base are reported but do not fail the check, so they can be
# fixed one page at a time. Names of other platforms must always be zero.
set -euo pipefail

BASE="${1:-origin/main}"
fail=0

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "ERROR: base ref '${BASE}' not found. Fetch it first."
  exit 2
fi

# --- positive controls: prove the search itself works before trusting a zero ---
if ! printf 'we list on Viator too\n' | grep -Eiq 'boatbooker|getyourguide|viator|bokun|clickboat'; then
  echo "ERROR: positive control failed (platform-name search is broken)."; exit 2
fi
if ! printf 'pay the Booking Fee\n' | grep -Eiq 'booking fee'; then
  echo "ERROR: positive control failed (wording search is broken)."; exit 2
fi

# Count matching lines for a pattern across HTML files at the base ref.
# $3 (optional) = extended regex of paths to leave out.
count_base() {
  local pat="$1" total=0 n f skip="${2:-}"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -n "$skip" ] && printf '%s\n' "$f" | grep -Eq -- "$skip"; then continue; fi
    n=$(git show "${BASE}:${f}" 2>/dev/null | grep -Eic -- "$pat" || true)
    total=$(( total + ${n:-0} ))
  done < <(git ls-tree -r --name-only "${BASE}" | grep -E '\.html$' || true)
  printf '%s' "$total"
}

# Same count across HTML files in the working tree.
count_head() {
  local pat="$1" total=0 n f skip="${2:-}"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    if [ -n "$skip" ] && printf '%s\n' "$f" | grep -Eq -- "$skip"; then continue; fi
    n=$(grep -Eic -- "$pat" "$f" || true)
    total=$(( total + ${n:-0} ))
  done < <( { git ls-files '*.html'; git ls-files --others --exclude-standard '*.html'; } | sort -u )
  printf '%s' "$total"
}

# Rule that must always be zero.
must_be_zero() {
  local label="$1" pat="$2" n
  n=$(count_head "$pat")
  if [ "$n" -gt 0 ]; then
    echo "FAIL  ${label}: found on ${n} line(s). Must be zero."
    { git ls-files '*.html'; git ls-files --others --exclude-standard '*.html'; } | sort -u | while IFS= read -r f; do
      [ -f "$f" ] && grep -Ein -- "$pat" "$f" | sed "s#^#        ${f}:#" | cut -c1-160 || true
    done
    fail=1
  else
    echo "ok    ${label}: 0"
  fi
}

# Rule that must not get worse than the base.
must_not_grow() {
  local label="$1" pat="$2" skip="${3:-}" b h
  b=$(count_base "$pat" "$skip")
  h=$(count_head "$pat" "$skip")
  if [ "$h" -gt "$b" ]; then
    echo "FAIL  ${label}: ${b} line(s) before, ${h} now. This change adds a rule break."
    fail=1
  elif [ "$h" -lt "$b" ]; then
    echo "ok    ${label}: ${b} before, ${h} now (improved)"
  else
    echo "ok    ${label}: ${h} (unchanged; old breaks still to fix: ${h})"
  fi
}

echo "Site rules: working tree against ${BASE}"
echo

# 1. Other platforms are never named on public pages.
must_be_zero  "names of other booking platforms" 'boatbooker|getyourguide|viator|bokun|clickboat'

# 2. Wording rules: no new breaks.
must_not_grow '"booking fee" (the word is deposit)'            'booking fee'
must_not_grow '"Catamaran Malta" (listing is La Zingara & Chardonnay)' 'catamaran malta'
must_not_grow '"catering" (catamarans are bring-your-own)'      'catering'
# Stripe may be named on operator-facing and internal pages only.
must_not_grow '"Stripe" on customer pages'                      'stripe' '^(for-operators|demo|captain|social-publish)'

# 3. Links to catamaranmalta.com must carry the tracking tag.
b=$(count_base 'href="https?://(www\.)?catamaranmalta\.com[^"]*"' ''); 
bt=$(count_base 'href="https?://(www\.)?catamaranmalta\.com[^"]*utm_source=bookitmalta[^"]*"' '')
h=$(count_head 'href="https?://(www\.)?catamaranmalta\.com[^"]*"' '')
ht=$(count_head 'href="https?://(www\.)?catamaranmalta\.com[^"]*utm_source=bookitmalta[^"]*"' '')
ub=$(( b - bt )); uh=$(( h - ht ))
if [ "$uh" -gt "$ub" ]; then
  echo "FAIL  untagged links to catamaranmalta.com: ${ub} line(s) before, ${uh} now."
  fail=1
else
  echo "ok    untagged links to catamaranmalta.com: ${uh} (was ${ub})"
fi

# 4. The analytics tag is still wired in.
if [ -f consent.js ] && grep -q 'wemhqvel3r' consent.js; then
  echo "ok    Clarity project id present in consent.js"
else
  echo "FAIL  Clarity project id missing from consent.js"
  fail=1
fi

# 5. No new serverless endpoint directly under /api (Vercel Hobby limit).
eb=$(git ls-tree -r --name-only "${BASE}" | grep -Ec '^api/[^/]+\.js$' || true)
eh=$( { git ls-files 'api/*.js'; git ls-files --others --exclude-standard 'api/*.js'; } | sort -u | grep -Ec '^api/[^/]+\.js$' || true)
if [ "${eh:-0}" -gt "${eb:-0}" ]; then
  echo "FAIL  new endpoint under /api: ${eb} before, ${eh} now. Add a mode to an existing endpoint."
  fail=1
else
  echo "ok    endpoints directly under /api: ${eh:-0} (was ${eb:-0})"
fi

# 6. No secret in the lines this change adds.
secret_pat='sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9_]{24,}|eyJhbGciOi[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9]{20,}'
added=$(git diff "${BASE}" -- . ':!package-lock.json' | grep -E '^\+[^+]' || true)
# Files not yet committed are not in the diff, so read them too.
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  added="${added}
$(cat -- "$f" 2>/dev/null || true)"
done < <(git ls-files --others --exclude-standard)
if printf '%s\n' "$added" | grep -Eq -- "$secret_pat"; then
  echo "FAIL  something that looks like a secret key is in the added lines. Remove it and rotate the key."
  fail=1
else
  echo "ok    no secret-looking keys in the added lines"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAILED"
  exit 1
fi
echo "RESULT: passed"
