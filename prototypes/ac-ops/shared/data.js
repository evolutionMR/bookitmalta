/* ============================================================
   AC Ops prototype — shared fake data + helpers  (v2)
   No backend. Store lives in localStorage per version so Tony
   can play with it and refresh without losing his edits.

   v2 adds: booking status (active/cancelled + note), boat
   closures with reasons, slot cancellation, move-to-date.
   ============================================================ */

const AC = (() => {
  const BOATS = [
    { id: "albert-v",    name: "Albert V",    cap: 40 },
    { id: "adventure-1", name: "Adventure 1", cap: 40 },
  ];
  const SLOTS = ["09:30", "14:30"];
  const SOURCES = [
    { id: "bim",    label: "BookItMalta", short: "BIM" },
    { id: "lync",   label: "Lync",        short: "Lync" },
    { id: "walkup", label: "Walk-up",     short: "Walk" },
    { id: "phone",  label: "Phone",       short: "Tel"  },
  ];

  function iso(d) { return d.toISOString().slice(0, 10); }
  function dayOffset(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  function fmtDay(isoDate) {
    const d = new Date(isoDate + "T12:00:00");
    const today = iso(new Date());
    const opts = { weekday: "short", day: "numeric", month: "short" };
    const label = d.toLocaleDateString("en-GB", opts);
    return isoDate === today ? "Today · " + label : label;
  }

  /* ---- seed, dates relative to "today" ---- */
  let _id = 1;
  function b(off, slot, boat, name, pax, source, phone) {
    return { id: "bk" + _id++, date: dayOffset(off), slot, boat, name, pax, source,
             phone: phone || "", boarded: false, status: "active", note: "" };
  }
  function seed() {
    _id = 1;
    return {
      closures: {},   /* key "date|slot|boatId" → { reason } */
      bookings: [
        /* today 09:30 — Albert V busy (34/40), Adventure 1 light (22/40) */
        b(0, "09:30", "albert-v", "Smith family", 6, "bim", "+44 7700 900123"),
        b(0, "09:30", "albert-v", "Garcia × 4", 4, "bim", "+34 612 345 678"),
        b(0, "09:30", "albert-v", "Lync group (Müller)", 12, "lync", "+49 171 2345678"),
        b(0, "09:30", "albert-v", "O'Brien couple", 2, "phone", "+353 87 123 4567"),
        b(0, "09:30", "albert-v", "Walk-up — Rossi", 5, "walkup", ""),
        b(0, "09:30", "albert-v", "Lync group (Dubois)", 5, "lync", "+33 6 12 34 56 78"),
        b(0, "09:30", "adventure-1", "Borg family", 4, "bim", "+356 7912 3456"),
        b(0, "09:30", "adventure-1", "Lync group (Nilsson)", 8, "lync", "+46 70 123 45 67"),
        b(0, "09:30", "adventure-1", "Walk-up — Chen", 3, "walkup", ""),
        b(0, "09:30", "adventure-1", "Kowalski × 7", 7, "phone", "+48 601 234 567"),
        /* today 14:30 — Albert V FULL (40/40), Adventure 1 31/40 */
        b(0, "14:30", "albert-v", "Lync group (Bianchi)", 15, "lync", "+39 333 123 4567"),
        b(0, "14:30", "albert-v", "Johnson party", 9, "bim", "+44 7700 900456"),
        b(0, "14:30", "albert-v", "Vella & friends", 6, "phone", "+356 9988 7766"),
        b(0, "14:30", "albert-v", "Walk-up — Petrov", 4, "walkup", ""),
        b(0, "14:30", "albert-v", "Hansen couple ×3", 6, "bim", "+45 20 12 34 56"),
        b(0, "14:30", "adventure-1", "Lync group (Novak)", 11, "lync", "+420 601 123 456"),
        b(0, "14:30", "adventure-1", "Williams family", 5, "bim", "+44 7700 900789"),
        b(0, "14:30", "adventure-1", "Walk-up — Aydin", 6, "walkup", ""),
        b(0, "14:30", "adventure-1", "Camilleri × 9", 9, "phone", "+356 7711 2233"),
        /* tomorrow — lighter day */
        b(1, "09:30", "albert-v", "Lync group (Schmidt)", 10, "lync", "+49 160 1234567"),
        b(1, "09:30", "albert-v", "Brown couple", 2, "bim", "+44 7700 900321"),
        b(1, "09:30", "adventure-1", "Lopez × 5", 5, "bim", "+34 698 765 432"),
        b(1, "14:30", "albert-v", "Fenech family", 4, "phone", "+356 7945 6789"),
        b(1, "14:30", "adventure-1", "Lync group (Janssen)", 7, "lync", "+31 6 1234 5678"),
        /* day after */
        b(2, "09:30", "albert-v", "Taylor group", 8, "bim", "+44 7700 900654"),
        b(2, "14:30", "adventure-1", "Lync group (Costa)", 6, "lync", "+351 912 345 678"),
      ],
    };
  }

  /* ---- storage (key bumped to proto2 — old plays discarded) ---- */
  function load(version) {
    try {
      const raw = localStorage.getItem("ac-ops-proto2-" + version);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.bookings)) {
          s.closures = s.closures || {};
          s.bookings.forEach(x => { x.status = x.status || "active"; x.note = x.note || ""; });
          return s;
        }
      }
    } catch (e) { /* fall through */ }
    return seed();
  }
  function save(version, store) {
    try { localStorage.setItem("ac-ops-proto2-" + version, JSON.stringify(store)); } catch (e) {}
  }
  function reset(version) {
    try { localStorage.removeItem("ac-ops-proto2-" + version); } catch (e) {}
    location.reload();
  }

  /* ---- queries (active bookings only, unless asked) ---- */
  function forDeparture(store, date, slot, boat, includeCancelled) {
    return store.bookings.filter(x =>
      x.date === date && x.slot === slot && (!boat || x.boat === boat) &&
      (includeCancelled || x.status === "active"));
  }
  function seats(list) { return list.reduce((s, x) => s + (x.status === "cancelled" ? 0 : x.pax), 0); }
  function bySource(list) {
    const out = {};
    SOURCES.forEach(s => out[s.id] = 0);
    list.forEach(x => { if (x.status !== "cancelled") out[x.source] = (out[x.source] || 0) + x.pax; });
    return out;
  }

  /* ---- closures: boat closed for a (date, slot) ---- */
  function ck(date, slot, boat) { return date + "|" + slot + "|" + boat; }
  function getClosure(store, date, slot, boat) { return store.closures[ck(date, slot, boat)] || null; }
  function setClosure(store, date, slot, boat, reason) { store.closures[ck(date, slot, boat)] = { reason: reason || "closed" }; }
  function clearClosure(store, date, slot, boat) { delete store.closures[ck(date, slot, boat)]; }
  function slotCancelled(store, date, slot) {
    return BOATS.every(b2 => !!getClosure(store, date, slot, b2.id));
  }
  function boatLeft(store, date, slot, boatId) {
    if (getClosure(store, date, slot, boatId)) return 0;
    const cap = BOATS.find(x => x.id === boatId).cap;
    return cap - seats(forDeparture(store, date, slot, boatId));
  }
  function slotLeft(store, date, slot) {
    return BOATS.reduce((s, b2) => s + boatLeft(store, date, slot, b2.id), 0);
  }

  /* ---- booking ops ---- */
  function cancelBooking(store, id, note) {
    const bk = store.bookings.find(x => x.id === id);
    if (bk) { bk.status = "cancelled"; bk.note = note || ""; bk.boarded = false; }
  }
  function restoreBooking(store, id) {
    const bk = store.bookings.find(x => x.id === id);
    if (!bk) return "Not found.";
    if (bk.pax > boatLeft(store, bk.date, bk.slot, bk.boat)) {
      return "No room — " + BOATS.find(x => x.id === bk.boat).name + " only has " + boatLeft(store, bk.date, bk.slot, bk.boat) + " seats left.";
    }
    bk.status = "active"; bk.note = "";
    return null;
  }

  /* ---- move every active booking of (date, slot) to another date,
          same slot, same boat. Returns error string or null. ---- */
  function moveDeparture(store, fromDate, slot, toDate, reason) {
    if (fromDate === toDate) return "Pick a different date.";
    const moving = forDeparture(store, fromDate, slot);
    if (!moving.length) return "Nothing to move.";
    for (const boat of BOATS) {
      const incoming = seats(moving.filter(x => x.boat === boat.id));
      if (!incoming) continue;
      if (getClosure(store, toDate, slot, boat.id)) {
        return boat.name + " is closed on " + fmtDay(toDate) + " " + slot + ".";
      }
      const room = boat.cap - seats(forDeparture(store, toDate, slot, boat.id));
      if (incoming > room) {
        return boat.name + " on " + fmtDay(toDate) + " only has " + room + " seats free (need " + incoming + ").";
      }
    }
    moving.forEach(x => { x.date = toDate; x.boarded = false; });
    BOATS.forEach(b2 => setClosure(store, fromDate, slot, b2.id, reason || "moved to " + fmtDay(toDate)));
    return null;
  }

  /* ---- cancel whole departure: closes both boats + cancels bookings ---- */
  function cancelDeparture(store, date, slot, reason) {
    forDeparture(store, date, slot).forEach(x => { x.status = "cancelled"; x.note = reason || "departure cancelled"; });
    BOATS.forEach(b2 => setClosure(store, date, slot, b2.id, reason || "cancelled"));
  }

  /* ---- WhatsApp vote ---- */
  function vote(version, name) {
    const msg = "Julian — I pick " + name + " (" + version + ") for the new booking system 👍";
    window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
  }

  return { BOATS, SLOTS, SOURCES, dayOffset, fmtDay, load, save, reset,
           forDeparture, seats, bySource,
           getClosure, setClosure, clearClosure, slotCancelled, boatLeft, slotLeft,
           cancelBooking, restoreBooking, moveDeparture, cancelDeparture, vote };
})();
