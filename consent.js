/*
 * BookItMalta cookie consent + analytics/advertising gate.
 *
 * Privacy-preserving default: NOTHING loads until the visitor explicitly
 * accepts. On consent we load Microsoft Clarity (usage analytics) and the
 * Meta pixel (advertising measurement / retargeting). Choice is remembered in
 * localStorage. A "Cookie settings" link is added to the footer so the visitor
 * can change their mind (GDPR withdrawal). If the visitor declines, neither
 * tool runs and no analytics/advertising cookies are set.
 */
(function () {
  "use strict";

  var CLARITY_ID = "wemhqvel3r";
  var META_PIXEL_ID = "959223593544701";
  // Bumped from "bim_consent" because the consent PURPOSE changed: we now load
  // the Meta advertising pixel, not just analytics. Versioning the key means
  // anyone who accepted the old analytics-only banner ("no ads") is re-prompted
  // and must give fresh consent before any advertising tracking loads (GDPR).
  var KEY = "bim_consent_v2"; // values: "granted" | "denied"

  function loadClarity() {
    if (window.__bimClarityLoaded) return;
    window.__bimClarityLoaded = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
  }

  function loadMetaPixel() {
    if (window.__bimPixelLoaded) return;
    window.__bimPixelLoaded = true;
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", META_PIXEL_ID);
    window.fbq("track", "PageView");
  }

  // Load everything the visitor has consented to.
  function loadConsented() {
    loadClarity();
    loadMetaPixel();
  }

  function getChoice() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setChoice(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  function removeBanner() {
    var b = document.getElementById("bim-consent");
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function injectStyles() {
    if (document.getElementById("bim-consent-style")) return;
    var s = document.createElement("style");
    s.id = "bim-consent-style";
    s.textContent = [
      "#bim-consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#F4EBD9;border-top:1px solid rgba(11,37,69,0.18);padding:14px 18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-family:'Manrope',-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 -2px 12px rgba(11,37,69,0.07);}",
      "#bim-consent .bim-c-text{flex:1;min-width:240px;font-size:13.5px;line-height:1.5;color:#1C3558;margin:0;}",
      "#bim-consent .bim-c-text a{color:#C85C2E;text-decoration:underline;text-underline-offset:2px;}",
      "#bim-consent .bim-c-actions{display:flex;gap:10px;}",
      "#bim-consent button{font-family:inherit;font-size:13px;font-weight:500;padding:9px 18px;border-radius:6px;cursor:pointer;}",
      "#bim-consent .bim-c-decline{border:1px solid #0B2545;background:transparent;color:#0B2545;}",
      "#bim-consent .bim-c-decline:hover{background:rgba(11,37,69,0.06);}",
      "#bim-consent .bim-c-accept{border:1px solid #C85C2E;background:#C85C2E;color:#fff;}",
      "#bim-consent .bim-c-accept:hover{background:#b34f25;border-color:#b34f25;}",
      "#bim-consent button:focus-visible{outline:2px solid #0B2545;outline-offset:2px;}",
      "@media (max-width:560px){#bim-consent .bim-c-actions{width:100%;}#bim-consent .bim-c-actions button{flex:1;}}"
    ].join("");
    document.head.appendChild(s);
  }

  function showBanner() {
    if (document.getElementById("bim-consent")) return;
    injectStyles();

    var bar = document.createElement("div");
    bar.id = "bim-consent";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Cookie consent");

    var text = document.createElement("p");
    text.className = "bim-c-text";
    text.innerHTML = "We use cookies for analytics (Microsoft Clarity) and advertising (the Meta pixel) — to understand how visitors use the site and to measure our ads. You can accept or decline. <a href=\"/privacy.html\">Privacy Policy</a>";

    var actions = document.createElement("div");
    actions.className = "bim-c-actions";

    var decline = document.createElement("button");
    decline.type = "button";
    decline.className = "bim-c-decline";
    decline.textContent = "Decline";
    decline.addEventListener("click", function () {
      setChoice("denied");
      removeBanner();
    });

    var accept = document.createElement("button");
    accept.type = "button";
    accept.className = "bim-c-accept";
    accept.textContent = "Accept";
    accept.addEventListener("click", function () {
      setChoice("granted");
      removeBanner();
      loadConsented();
    });

    actions.appendChild(decline);
    actions.appendChild(accept);
    bar.appendChild(text);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  }

  function injectFooterLink() {
    var footer = document.querySelector("footer .wrap") || document.querySelector("footer");
    if (!footer || footer.querySelector(".bim-cookie-settings")) return;
    var sep = document.createElement("span");
    sep.textContent = " · ";
    sep.className = "bim-cookie-sep";
    var link = document.createElement("a");
    link.href = "#";
    link.className = "bim-cookie-settings";
    link.textContent = "Cookie settings";
    link.style.color = "inherit";
    link.addEventListener("click", function (e) {
      e.preventDefault();
      showBanner();
    });
    footer.appendChild(sep);
    footer.appendChild(link);
  }

  function init() {
    var choice = getChoice();
    if (choice === "granted") {
      loadConsented();
    } else if (choice !== "denied") {
      showBanner();
    }
    injectFooterLink();
    window.showCookieConsent = showBanner;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
