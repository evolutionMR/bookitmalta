// api/_lib/calendar.js
//
// Generates calendar event data for confirmed bookings — used by:
//   - customer booking-confirmed email (.ics attachment + Google/Outlook URLs)
//   - /booking-confirmed.html post-payment page (Add-to-Calendar buttons)
//
// All times are computed in Europe/Malta local time. The .ics output uses
// floating local TZID so calendar apps interpret times correctly across
// CET/CEST transitions.
//
// Inputs:
//   booking       — row from <schema>.bookings (charter_date, party_size,
//                   tour_option, customer_name, etc.)
//   tenantConfig  — entry from config/tenants.js (calendarEventTitle,
//                   experienceDurationHours, meetingPointAddress, etc.)
//
// Time resolution:
//   • If booking.tour_option matches HH:MM (e.g. '09:30'), use it as start.
//   • Otherwise fall back to tenantConfig.defaultStartTime (Bandama '09:00').
//   • If neither exists, default to 09:00.
//
// Outputs:
//   - buildIcsContent(...)  → string ready to attach as 'booking.ics'
//   - buildGoogleCalUrl(...) → URL string
//   - buildOutlookUrl(...)   → URL string
//   - buildEventTimes(...)   → { startLocal, endLocal } for reuse

/**
 * Resolve start time string ('HH:MM') from booking or tenant fallback.
 */
function resolveStartTime(booking, tenantConfig) {
  const slot = booking && booking.tour_option;
  if (typeof slot === 'string' && /^\d{2}:\d{2}$/.test(slot)) {
    return slot;
  }
  if (tenantConfig && typeof tenantConfig.defaultStartTime === 'string') {
    return tenantConfig.defaultStartTime;
  }
  return '09:00';
}

/**
 * Add N hours to an HH:MM string, returning HH:MM (no overflow past 23:59).
 */
function addHours(hhmm, hours) {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  const totalMinutes = h * 60 + m + Math.round(hours * 60);
  const endH = Math.min(23, Math.floor(totalMinutes / 60));
  const endM = totalMinutes % 60;
  return String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
}

/**
 * Format YYYY-MM-DD + HH:MM → YYYYMMDDTHHMMSS (no Z; local-floating).
 * Used for iCal DTSTART with TZID=Europe/Malta.
 */
function fmtIcsLocal(dateIso, hhmm) {
  const d = dateIso.replace(/-/g, '');
  const t = hhmm.replace(':', '') + '00';
  return `${d}T${t}`;
}

/**
 * Format YYYY-MM-DD + HH:MM Malta local → UTC ISO string (best effort).
 * Used for Google Calendar add-event URLs which want UTC.
 *
 * Approximation: Malta is UTC+1 (CET) / UTC+2 (CEST). DST runs last-Sunday-March
 * to last-Sunday-October. We compute the offset for the given date.
 */
function maltaLocalToUtc(dateIso, hhmm) {
  const [Y, M, D] = dateIso.split('-').map(n => parseInt(n, 10));
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  // Determine DST window for year Y
  const lastSundayOfMarch = lastSunday(Y, 3);
  const lastSundayOfOctober = lastSunday(Y, 10);
  // DST begins 01:00 UTC on lastSundayOfMarch; ends 01:00 UTC lastSundayOfOctober
  const dateUtcGuess = Date.UTC(Y, M - 1, D, h, m);
  const dstStart = Date.UTC(Y, 2, lastSundayOfMarch, 1);
  const dstEnd   = Date.UTC(Y, 9, lastSundayOfOctober, 1);
  const inDst = dateUtcGuess >= dstStart && dateUtcGuess < dstEnd;
  const offsetMinutes = inDst ? 120 : 60;          // Malta is +1 or +2
  const utcMs = dateUtcGuess - offsetMinutes * 60 * 1000;
  return new Date(utcMs);
}

function lastSunday(year, monthOneBased) {
  // Day-of-week in JS: 0=Sun. Find last day of month, walk back to Sunday.
  const lastDay = new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
  for (let d = lastDay; d >= 1; d--) {
    const wd = new Date(Date.UTC(year, monthOneBased - 1, d)).getUTCDay();
    if (wd === 0) return d;
  }
  return 1;
}

/**
 * Format a Date object as YYYYMMDDTHHMMSSZ (Google/Outlook URL format).
 */
function fmtIcsUtc(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear()
       + pad(d.getUTCMonth() + 1)
       + pad(d.getUTCDate())
       + 'T'
       + pad(d.getUTCHours())
       + pad(d.getUTCMinutes())
       + pad(d.getUTCSeconds())
       + 'Z';
}

/**
 * Build start/end local + UTC times for a booking.
 * Returned object:
 *   { startTime: 'HH:MM', endTime: 'HH:MM',
 *     startLocalIcs: 'YYYYMMDDTHHMMSS', endLocalIcs: 'YYYYMMDDTHHMMSS',
 *     startUtcGoogle: 'YYYYMMDDTHHMMSSZ', endUtcGoogle: 'YYYYMMDDTHHMMSSZ' }
 */
function buildEventTimes(booking, tenantConfig) {
  const startTime = resolveStartTime(booking, tenantConfig);
  const durationHours = (tenantConfig && tenantConfig.experienceDurationHours) || 5;
  const endTime = addHours(startTime, durationHours);

  const dateIso = String(booking.charter_date).slice(0, 10);   // YYYY-MM-DD

  return {
    startTime,
    endTime,
    dateIso,
    startLocalIcs: fmtIcsLocal(dateIso, startTime),
    endLocalIcs:   fmtIcsLocal(dateIso, endTime),
    startUtcGoogle: fmtIcsUtc(maltaLocalToUtc(dateIso, startTime)),
    endUtcGoogle:   fmtIcsUtc(maltaLocalToUtc(dateIso, endTime)),
  };
}

/**
 * Build the event description used across .ics + URL formats.
 */
function buildEventDescription(booking, tenantConfig) {
  const lines = [
    `Booking confirmed.`,
    ``,
    `Booking code: ${shortBookingCode(booking)}`,
    `Party size:   ${booking.party_size}`,
    `Operator:     ${tenantConfig.name}`,
    ``,
    `Meeting point: ${tenantConfig.meetingPointAddress || 'See operator email'}.`,
    ``,
    `${tenantConfig.operatorFirstName || tenantConfig.name} will be in touch with the final pre-charter briefing.`,
    ``,
    `Managed by BookItMalta — bookitmalta.com`,
  ];
  return lines.join('\n');
}

function shortBookingCode(booking) {
  const src = booking.id || booking.enquiry_id || '';
  return String(src).replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * iCal text escaping per RFC 5545: \ , ;  must be backslash-escaped,
 * newlines become \n literal.
 */
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g,  '\\;')
    .replace(/,/g,  '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Build a self-contained .ics calendar file as a UTF-8 string.
 * Caller can attach via Resend's attachments[].content (base64 or text).
 *
 * Uses Europe/Malta TZID so the event renders at the correct local time
 * regardless of the recipient's timezone.
 */
function buildIcsContent(booking, tenantConfig) {
  const times = buildEventTimes(booking, tenantConfig);
  const dtstamp = fmtIcsUtc(new Date());
  const uid = shortBookingCode(booking).toLowerCase()
            + '-' + (booking.id || 'enq').toString().slice(0, 8)
            + '@bookitmalta.com';

  const title = tenantConfig.calendarEventTitle || `${tenantConfig.name} — Charter`;
  const description = buildEventDescription(booking, tenantConfig);
  const location = tenantConfig.meetingPointAddress || '';

  // Folded lines per RFC 5545 (lines >75 octets should be wrapped, but most
  // calendar apps accept un-wrapped lines fine — keep it simple).
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BookItMalta//Bookings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // Europe/Malta VTIMEZONE definition — needed so DTSTART;TZID renders right
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Malta',
    'BEGIN:STANDARD',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Europe/Malta:${times.startLocalIcs}`,
    `DTEND;TZID=Europe/Malta:${times.endLocalIcs}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    `ORGANIZER;CN=${icsEscape(tenantConfig.name)}:mailto:noreply@bookitmalta.com`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].filter(Boolean).join('\r\n');
}

/**
 * Build a one-tap "Add to Google Calendar" URL.
 */
function buildGoogleCalUrl(booking, tenantConfig) {
  const times = buildEventTimes(booking, tenantConfig);
  const title = tenantConfig.calendarEventTitle || `${tenantConfig.name} — Charter`;
  const description = buildEventDescription(booking, tenantConfig);
  const location = tenantConfig.meetingPointAddress || '';

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   title,
    dates:  `${times.startUtcGoogle}/${times.endUtcGoogle}`,
    details: description,
    location,
    ctz:    'Europe/Malta',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Build a one-tap "Add to Outlook (web)" URL.
 * Works for outlook.live.com (personal Outlook). Office365 has a different URL.
 */
function buildOutlookUrl(booking, tenantConfig) {
  const times = buildEventTimes(booking, tenantConfig);
  const title = tenantConfig.calendarEventTitle || `${tenantConfig.name} — Charter`;
  const description = buildEventDescription(booking, tenantConfig);
  const location = tenantConfig.meetingPointAddress || '';

  // Outlook wants ISO-8601 local with TZID hint via separate param. Easiest:
  // pass UTC ISO and Outlook will localize for the user.
  const startIso = isoFromGoogleFmt(times.startUtcGoogle);
  const endIso   = isoFromGoogleFmt(times.endUtcGoogle);

  const params = new URLSearchParams({
    path:    '/calendar/action/compose',
    rru:     'addevent',
    subject: title,
    body:    description,
    startdt: startIso,
    enddt:   endIso,
    location,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function isoFromGoogleFmt(s) {
  // 20260611T073000Z → 2026-06-11T07:30:00Z
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`;
}

module.exports = {
  buildIcsContent,
  buildGoogleCalUrl,
  buildOutlookUrl,
  buildEventTimes,
  buildEventDescription,
  shortBookingCode,
  // exported for unit tests
  resolveStartTime,
  addHours,
  maltaLocalToUtc,
  icsEscape,
};
