#!/usr/bin/env python3
"""BookItMalta site-rule checks.

Usage:  python3 scripts/check-site-rules.py [base-ref]      (default base: origin/main)

Compares the working tree against the base and fails if this change newly breaks a rule.
Old breaks already on the base are reported but do not fail, so they can be fixed one
file at a time. Counting is per file and per match, so removing a break in one file does
not buy room for a new one somewhere else. Names of other booking platforms must be zero.

Exit codes: 0 passed, 1 a rule is broken, 2 the check itself could not run.
"""
import os
import re
import subprocess
import sys


def run(*args):
    return subprocess.run(["git", *args], capture_output=True)


def die(msg):
    print("ERROR: " + msg)
    sys.exit(2)


top = run("rev-parse", "--show-toplevel")
if top.returncode != 0:
    die("not inside a git repository.")
os.chdir(top.stdout.decode().strip())

BASE = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
if run("rev-parse", "--verify", "--quiet", BASE + "^{commit}").returncode != 0:
    die("base ref '%s' not found. Fetch it first." % BASE)


def zlist(*args):
    out = run(*args).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


head_files = sorted(
    set(zlist("ls-files", "-z") + zlist("ls-files", "-z", "--others", "--exclude-standard"))
)
head_files = [f for f in head_files if os.path.isfile(f)]
base_files = set(zlist("ls-tree", "-r", "-z", "--name-only", BASE))

_cache = {}


def head_text(path):
    try:
        with open(os.fsencode(path), "rb") as fh:
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def base_text(path):
    if path not in base_files:
        return ""
    if path not in _cache:
        _cache[path] = run("show", "%s:%s" % (BASE, path)).stdout.decode("utf-8", "replace")
    return _cache[path]


TEXT_EXT = (".html", ".js", ".mjs", ".cjs", ".ts", ".css", ".txt", ".xml", ".svg", ".json")
NOT_SITE = (".github/", "scripts/", "db/", "docs/")


def is_site_text(path):
    """Files that are part of the site or its server code (not notes or tooling)."""
    if path.startswith(NOT_SITE) or path.endswith(".md"):
        return False
    if path in ("package.json", "package-lock.json", "vercel.json"):
        return False
    return path.lower().endswith(TEXT_EXT)


def is_html(path):
    return path.lower().endswith(".html")


def is_server_code(path):
    """Server code builds the customer emails and payment descriptions."""
    return (path.startswith("api/") or path.startswith("config/")) and path.lower().endswith(
        (".js", ".mjs", ".cjs", ".ts")
    )


def is_customer_html(path):
    """Pages customers see. Operator-facing and internal pages may name the payment company."""
    if not is_html(path):
        return False
    first = path.split("/")[0]
    if first in ("demo", "captain", "for-operators"):
        return False
    return path not in ("for-operators.html", "demo.html", "social-publish.html")


def is_function(path):
    """A file Vercel turns into a serverless function: under /api, not under an _ path."""
    if not path.startswith("api/"):
        return False
    if not path.lower().endswith((".js", ".mjs", ".cjs", ".ts")):
        return False
    return not any(part.startswith("_") for part in path.split("/")[1:])


PLATFORMS = re.compile(r"boatbooker|getyourguide|viator|bokun|clickboat", re.I)
BOOKING_FEE = re.compile(r"booking[\s\-]*fee", re.I)
CAT_MALTA = re.compile(r"catamaran\s+malta", re.I)
CATERING = re.compile(r"catering", re.I)
STRIPE = re.compile(r"\bstripe\b", re.I)
CAT_LINK = re.compile(r"""href\s*=\s*(["'])https?://(?:www\.)?catamaranmalta\.com[^"']*\1""", re.I)
SECRET = re.compile(
    r"sk_live_[A-Za-z0-9]{8,}|sk_test_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}"
    r"|whsec_[A-Za-z0-9]{8,}|\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}\b"
    r"|eyJhbGciOi[A-Za-z0-9_\-]{20,}|sbp_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9_\-]{16,}"
)

# --- positive controls: prove each search works before trusting a zero -----------------
controls = [
    (PLATFORMS, "we list on Viator too"),
    (BOOKING_FEE, "pay the Booking Fee"),
    (CAT_MALTA, "Catamaran  Malta - Sliema"),
    (CATERING, "full Catering on board"),
    (STRIPE, "paid through Stripe."),
    (CAT_LINK, "<a href='https://catamaranmalta.com/x'>"),
    (SECRET, "key = sk_" + "live_" + "A1b2C3d4E5f6"),
]
for rx, sample in controls:
    if not rx.search(sample):
        die("positive control failed for pattern %r." % rx.pattern[:40])
if STRIPE.search("a striped awning") or SECRET.search("are_you_sure_you_want_to_continue"):
    die("negative control failed (a pattern is matching ordinary words).")

html_head = [f for f in head_files if is_html(f)]
if len(html_head) < 5:
    die("only %d HTML page(s) found. The file listing is not working, so a pass would mean nothing." % len(html_head))
if not any("consent.js" in head_text(f) for f in html_head):
    die("no page includes consent.js. The file reading is not working, or the analytics tag was removed everywhere.")

fail = False


def bad(msg):
    global fail
    fail = True
    print("FAIL  " + msg)


def ok(msg):
    print("ok    " + msg)


def show_hits(rx, path, limit=5):
    for n, line in enumerate(head_text(path).splitlines(), 1):
        if rx.search(line):
            print("        %s:%d: %s" % (path, n, line.strip()[:120]))
            limit -= 1
            if limit == 0:
                return


def must_be_zero(label, rx, files):
    hits = [(f, len(rx.findall(head_text(f)))) for f in files]
    hits = [(f, n) for f, n in hits if n]
    if hits:
        bad("%s: found %d time(s). Must be zero." % (label, sum(n for _, n in hits)))
        for f, _ in hits:
            show_hits(rx, f)
    else:
        ok("%s: 0 (in %d files)" % (label, len(files)))


def must_not_grow(label, rx, files):
    """Per file, per match: no file may have more matches than it had on the base."""
    total_base = total_head = 0
    worse = []
    for f in files:
        b = len(rx.findall(base_text(f)))
        h = len(rx.findall(head_text(f)))
        total_base += b
        total_head += h
        if h > b:
            worse.append((f, b, h))
    # matches in files this change deleted still count toward the "before" total
    gone = [f for f in base_files if f not in set(head_files)]
    if worse:
        bad("%s: this change adds a rule break." % label)
        for f, b, h in worse:
            print("        %s: %d before, %d now" % (f, b, h))
            show_hits(rx, f, 3)
    elif total_head < total_base:
        ok("%s: %d before, %d now (improved)" % (label, total_base, total_head))
    else:
        ok("%s: %d, unchanged (old breaks still to fix: %d)" % (label, total_head, total_head))
    return gone


print("Site rules: working tree against %s" % BASE)
print()

site_text = [f for f in head_files if is_site_text(f)]
wording_files = [f for f in head_files if is_html(f) or is_server_code(f)]
customer_html = [f for f in head_files if is_customer_html(f)]

# 1. Other booking platforms are never named, anywhere in the site or its server code.
must_be_zero("names of other booking platforms", PLATFORMS, site_text)

# 2. Wording rules, in pages and in the server code that writes customer emails.
must_not_grow('"booking fee" (the word is deposit)', BOOKING_FEE, wording_files)
must_not_grow('"Catamaran Malta" (the listing is La Zingara & Chardonnay)', CAT_MALTA, wording_files)
must_not_grow('"catering" (the catamarans are bring-your-own)', CATERING, wording_files)
must_not_grow('"Stripe" on customer pages', STRIPE, customer_html)

# 3. Every link to catamaranmalta.com carries the tracking tag.
def untagged(text):
    return sum(1 for m in CAT_LINK.finditer(text) if "utm_source=bookitmalta" not in m.group(0))


worse = []
tb = th = 0
for f in html_head:
    b, h = untagged(base_text(f)), untagged(head_text(f))
    tb += b
    th += h
    if h > b:
        worse.append((f, b, h))
if worse:
    bad("links to catamaranmalta.com without the tracking tag: this change adds one.")
    for f, b, h in worse:
        print("        %s: %d before, %d now" % (f, b, h))
else:
    ok("untagged links to catamaranmalta.com: %d (was %d)" % (th, tb))

# 4. The analytics tag is still wired in.
if "wemhqvel3r" in head_text("consent.js"):
    ok("Clarity project id present in consent.js")
else:
    bad("Clarity project id missing from consent.js")
indexable_without = [
    f for f in html_head
    if "consent.js" not in head_text(f) and not re.search(r'name=["\']robots["\'][^>]*noindex', head_text(f), re.I)
]
indexable_without_base = [
    f for f in base_files
    if is_html(f) and "consent.js" not in base_text(f)
    and not re.search(r'name=["\']robots["\'][^>]*noindex', base_text(f), re.I)
]
new_missing = [f for f in indexable_without if f not in indexable_without_base]
if new_missing:
    bad("indexable page(s) without consent.js (the analytics tag): " + ", ".join(new_missing))
else:
    ok("indexable pages without consent.js: %d (was %d)" % (len(indexable_without), len(indexable_without_base)))

# 5. No new serverless function (Vercel Hobby allows 12 in total).
fb = sorted(f for f in base_files if is_function(f))
fh = sorted(f for f in head_files if is_function(f))
new_fn = [f for f in fh if f not in fb]
if len(fh) > len(fb):
    bad("new serverless function(s): %s. %d before, %d now. Add a mode to an existing endpoint." % (", ".join(new_fn), len(fb), len(fh)))
else:
    ok("serverless functions under /api: %d (was %d)" % (len(fh), len(fb)))

# 6. No secret in what this change adds.
diff = run("diff", BASE, "--", ".", ":!package-lock.json").stdout.decode("utf-8", "replace")
added = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++ ")]
for f in zlist("ls-files", "-z", "--others", "--exclude-standard"):
    if os.path.isfile(f):
        added.extend(head_text(f).splitlines())
leaks = [l for l in added if SECRET.search(l)]
if leaks:
    bad("%d added line(s) look like a secret key. Remove them and rotate the key. (Lines not printed.)" % len(leaks))
else:
    ok("no secret-looking keys in the added lines")

# 7. Nothing the site needs was deleted without notice.
deleted_pages = sorted(f for f in base_files if is_html(f) and f not in set(head_files))
if deleted_pages:
    print("note  page(s) removed by this change: " + ", ".join(deleted_pages))

print()
if fail:
    print("RESULT: FAILED")
    sys.exit(1)
print("RESULT: passed")
