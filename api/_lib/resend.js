// api/_lib/resend.js
//
// Resend client + email templates.
//
// Single Resend account (RESEND_API_KEY shared across tenants), but the
// FROM address can be per-tenant via env var BANDAMA_RESEND_FROM, etc.
// Reply-to is per-tenant (BANDAMA_OPERATOR_EMAIL) so customer replies go
// straight to the captain, never to BookItMalta's inbox.

const { Resend } = require('resend');
const { getTenantEnv, getTenantEnvOptional } = require('./tenant.js');

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY');
  resendClient = new Resend(key);
  return resendClient;
}

// Plain-text email body builder for editorial tone (no marketing fluff)
function fmtEUR(cents) {
  return `€${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function fmtDate(isoDate) {
  // 2026-06-15 → "Monday 15 June 2026"
  try {
    return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

// =============================================================================
// CAPTAIN: new enquiry notification (with confirm/decline magic links)
// =============================================================================
function captainEnquiryEmail({ tenantConfig, enquiry, baseUrl }) {
  const confirmUrl = `${baseUrl}/api/captain?token=${enquiry.captain_token}&action=confirm&tenant=${tenantConfig.slug}`;
  const declineUrl = `${baseUrl}/api/captain?token=${enquiry.captain_token}&action=decline&tenant=${tenantConfig.slug}`;
  const reviewUrl  = `${baseUrl}/api/captain?token=${enquiry.captain_token}&tenant=${tenantConfig.slug}`;

  const subject = `[${tenantConfig.name}] New enquiry — ${fmtDate(enquiry.preferred_date)} — ${enquiry.party_size} guests`;

  const text = `
New enquiry from bookitmalta.com.

Customer: ${enquiry.customer_name}
Email:    ${enquiry.customer_email}
Phone:    ${enquiry.customer_phone || '—'}

Preferred date:  ${fmtDate(enquiry.preferred_date)}
Alternative:     ${enquiry.alt_dates || '—'}
Party size:      ${enquiry.party_size}
${enquiry.tour_option ? `Tour option:     ${enquiry.tour_option}\n` : ''}
Message:
${enquiry.message || '(none)'}

────────────────────────────────────────
REVIEW + ACT
────────────────────────────────────────

Open the enquiry to confirm, decline, or suggest alternative dates:
${reviewUrl}

Or use the one-click shortcuts:
  ✅ CONFIRM — send Stripe deposit link to customer:
     ${confirmUrl}

  ❌ DECLINE — apologise and close enquiry:
     ${declineUrl}

────────────────────────────────────────

If you confirm, the customer receives an automated email with a secure
Stripe link for the ${fmtEUR(tenantConfig.depositAmountCents)} deposit. The booking is locked the moment
they pay. Balance of ${fmtEUR(tenantConfig.charterPriceCents - tenantConfig.depositAmountCents)} is settled directly with you on the day.

BookItMalta · bookitmalta.com
`;

  return { subject, text };
}

// =============================================================================
// CUSTOMER: enquiry received acknowledgement
// =============================================================================
function customerEnquiryAckEmail({ tenantConfig, enquiry }) {
  const subject = `We've received your enquiry — ${tenantConfig.name}`;
  const text = `
Hi ${enquiry.customer_name.split(' ')[0] || 'there'},

Thanks for your enquiry. ${tenantConfig.operatorFirstName || tenantConfig.name} will review personally and come back to you within 24 hours via email or WhatsApp to confirm availability.

Your enquiry:
  Date:        ${fmtDate(enquiry.preferred_date)}
  Party size:  ${enquiry.party_size}
  ${enquiry.alt_dates ? `Alternative: ${enquiry.alt_dates}\n  ` : ''}

What happens next
  1. Captain reviews and confirms availability (within 24h).
  2. You receive a secure Stripe link to pay the ${fmtEUR(tenantConfig.depositAmountCents)} deposit.
  3. The moment payment lands, the date is locked.
  4. Balance of ${fmtEUR(tenantConfig.charterPriceCents - tenantConfig.depositAmountCents)} is settled directly with the captain on the day.

Cancellation: full refund of deposit up to ${tenantConfig.cancellationWindowDays} days before the charter. After that the deposit is forfeit.

If you need to reach us in the meantime, just reply to this email.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CUSTOMER: deposit link (after captain confirms)
// =============================================================================
function customerDepositLinkEmail({ tenantConfig, enquiry, paymentUrl }) {
  const subject = `Confirmed — pay your deposit to lock in ${fmtDate(enquiry.preferred_date)}`;
  const text = `
Hi ${enquiry.customer_name.split(' ')[0] || 'there'},

Good news — ${tenantConfig.operatorFirstName || tenantConfig.name} has confirmed availability for ${fmtDate(enquiry.preferred_date)}.

Pay your ${fmtEUR(tenantConfig.depositAmountCents)} deposit here to lock the date:

${paymentUrl}

The link is valid for ${tenantConfig.confirmationExpiryHours} hours. Once payment lands, you'll receive a final confirmation by email.

The remaining ${fmtEUR(tenantConfig.charterPriceCents - tenantConfig.depositAmountCents)} is settled directly with the captain on the day of the charter.

Cancellation policy: full refund of the deposit if you cancel up to ${tenantConfig.cancellationWindowDays} days before the charter. After that the deposit is forfeit.

Looking forward to having you aboard.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CUSTOMER: deposit paid → booking confirmed
// =============================================================================
function customerBookingConfirmedEmail({ tenantConfig, booking }) {
  const subject = `Booking confirmed — ${fmtDate(booking.charter_date)} aboard ${tenantConfig.boat}`;
  const text = `
Hi ${booking.customer_name.split(' ')[0] || 'there'},

Your booking is locked in.

  Date:         ${fmtDate(booking.charter_date)}
  Party size:   ${booking.party_size}
  Deposit paid: ${fmtEUR(booking.deposit_paid_cents)}
  Balance due:  ${fmtEUR(booking.balance_due_cents)} (paid directly to captain on the day)

${tenantConfig.operatorFirstName || tenantConfig.name} will be in touch shortly with meeting point details and a final pre-charter briefing.

Cancellation policy: full refund of deposit if you cancel up to ${tenantConfig.cancellationWindowDays} days before the charter date. After that the deposit is forfeit.

Looking forward to your day on the water.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CAPTAIN: deposit paid → booking confirmed
// =============================================================================
function captainBookingConfirmedEmail({ tenantConfig, booking }) {
  const subject = `[${tenantConfig.name}] BOOKED — ${fmtDate(booking.charter_date)} — ${booking.customer_name}`;
  const text = `
Deposit paid — booking is locked.

  Customer:     ${booking.customer_name}
  Email:        ${booking.customer_email}
  Phone:        ${booking.customer_phone || '—'}
  Date:         ${fmtDate(booking.charter_date)}
  Party size:   ${booking.party_size}
  Deposit paid: ${fmtEUR(booking.deposit_paid_cents)} (this is our commission)
  Balance:      ${fmtEUR(booking.balance_due_cents)} — collect on the day

Get in touch with the customer to share meeting point + briefing.

BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CUSTOMER: enquiry declined
// =============================================================================
function customerDeclineEmail({ tenantConfig, enquiry, captainNote }) {
  const subject = `Update on your enquiry — ${tenantConfig.name}`;
  const text = `
Hi ${enquiry.customer_name.split(' ')[0] || 'there'},

Thanks for your interest in chartering with ${tenantConfig.name}. Unfortunately we're unable to take your booking for ${fmtDate(enquiry.preferred_date)}.

${captainNote ? captainNote + '\n\n' : ''}If your dates are flexible, please reply to this email — we'd love to help find an alternative.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CUSTOMER: waitlist confirmation
// =============================================================================
function customerWaitlistEmail({ tenantConfig, waitlistEntry }) {
  const subject = `You're on the waitlist — ${fmtDate(waitlistEntry.requested_date)}`;
  const text = `
Hi ${waitlistEntry.customer_name.split(' ')[0] || 'there'},

${fmtDate(waitlistEntry.requested_date)} is currently booked. We've added you to the waitlist — you're position ${waitlistEntry.position} in the queue.

If the booking ahead of you cancels, we'll email you immediately with a ${tenantConfig.waitlistOfferExpiryHours}-hour window to claim the slot.

${waitlistEntry.alt_dates ? `You mentioned these alternative dates: ${waitlistEntry.alt_dates}. ${tenantConfig.operatorFirstName || 'The captain'} will check availability for those too and come back to you if any look promising.\n\n` : ''}If your plans change and you'd like to come off the waitlist, just reply to this email.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CUSTOMER: waitlist slot opened → claim window
// =============================================================================
function customerWaitlistOfferEmail({ tenantConfig, waitlistEntry, claimUrl }) {
  const subject = `A slot just opened — ${fmtDate(waitlistEntry.requested_date)}`;
  const text = `
Hi ${waitlistEntry.customer_name.split(' ')[0] || 'there'},

Good news — ${fmtDate(waitlistEntry.requested_date)} just opened up. You're at the top of the waitlist.

Claim the slot here (valid for ${tenantConfig.waitlistOfferExpiryHours} hours):
${claimUrl}

After that window the offer goes to the next person in the queue.

${tenantConfig.name}
via BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// CAPTAIN: confirmation that their action was recorded
// =============================================================================
function captainActionConfirmedEmail({ tenantConfig, enquiry, action }) {
  const subject = `[${tenantConfig.name}] ${action.toUpperCase()} recorded — ${enquiry.customer_name}`;
  const text = `
You ${action === 'confirm' ? 'confirmed' : 'declined'} the enquiry from ${enquiry.customer_name} for ${fmtDate(enquiry.preferred_date)}.

${action === 'confirm'
  ? `An automated email with a secure Stripe deposit link (${fmtEUR(tenantConfig.depositAmountCents)}) has been sent to ${enquiry.customer_email}. You'll receive a "BOOKED" notification the moment they pay.`
  : `The customer has been notified that the date isn't available.`}

BookItMalta · bookitmalta.com
`;
  return { subject, text };
}

// =============================================================================
// SEND wrapper
// =============================================================================
async function sendEmail({ tenantSlug, tenantConfig, to, subject, text, replyTo }) {
  const resend = getResend();
  const from = getTenantEnvOptional(tenantSlug, 'RESEND_FROM', 'BookItMalta <noreply@bookitmalta.com>');
  const operatorEmail = getTenantEnvOptional(tenantSlug, 'OPERATOR_EMAIL', null);

  return resend.emails.send({
    from,
    to,
    subject,
    text,
    reply_to: replyTo || operatorEmail || undefined,
  });
}

module.exports = {
  sendEmail,
  captainEnquiryEmail,
  customerEnquiryAckEmail,
  customerDepositLinkEmail,
  customerBookingConfirmedEmail,
  captainBookingConfirmedEmail,
  customerDeclineEmail,
  customerWaitlistEmail,
  customerWaitlistOfferEmail,
  captainActionConfirmedEmail,
};
