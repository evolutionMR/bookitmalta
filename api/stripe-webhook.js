// api/stripe-webhook.js
//
// POST /api/stripe-webhook?tenant=<slug>
//
// Stripe webhook receiver. The `tenant` query param tells us which Stripe
// account is sending the event (so we can pick the right webhook secret
// for signature verification).
//
// Events handled:
//   • checkout.session.completed     — Payment Link path: payment succeeded
//   • payment_intent.succeeded       — fallback for direct PaymentIntents
//   • charge.refunded                — partial or full refund
//   • payment_intent.payment_failed  — log + ignore (customer retries)
//
// Idempotency: we use stripe_payment_intent_id as the booking primary
// "fingerprint" — re-running the same event is a no-op (booking exists,
// we just no-op the insert).

const { resolveTenant, getTenantEnv } = require('./_lib/tenant.js');
const { getSupabase } = require('./_lib/supabase.js');
const { verifyWebhook, deactivatePaymentLink, getStripe } = require('./_lib/stripe.js');
const {
  sendEmail,
  customerBookingConfirmedEmail,
  captainBookingConfirmedEmail,
  customerWaitlistOfferEmail,
} = require('./_lib/resend.js');

// CRITICAL: disable Vercel's body parser — we need the raw body to verify
// the Stripe signature. The `config` export below tells Vercel to give us
// the raw Buffer. The .config assignment MUST come AFTER `module.exports = ...`
// otherwise it gets wiped by the function assignment.
async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let tenant, config;
  try {
    ({ slug: tenant, config } = resolveTenant(req));
  } catch (e) {
    return res.status(400).send('Missing tenant');
  }

  // Read raw body
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).send('Could not read body');
  }

  // Verify signature
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing Stripe-Signature header');
  }

  let event;
  try {
    event = verifyWebhook(tenant, rawBody, signature);
  } catch (e) {
    console.error('[stripe-webhook] signature verification failed:', e.message);
    return res.status(400).send(`Signature verification failed: ${e.message}`);
  }

  // Dispatch
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted({ event, tenant, config });
        break;
      case 'payment_intent.succeeded':
        // Often fires after checkout.session.completed — idempotent.
        await handlePaymentSucceeded({ event, tenant, config });
        break;
      case 'charge.refunded':
        await handleChargeRefunded({ event, tenant, config });
        break;
      case 'payment_intent.payment_failed':
        console.log('[stripe-webhook] payment_intent.payment_failed', event.data.object.id);
        break;
      default:
        console.log('[stripe-webhook] unhandled event type:', event.type);
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', e);
    return res.status(500).send('Handler error');
  }

  // Always 200 to Stripe so it doesn't retry indefinitely on transient app errors.
  return res.status(200).send('ok');
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };

// =============================================================================
// checkout.session.completed
// =============================================================================
async function handleCheckoutCompleted({ event, tenant, config }) {
  const session = event.data.object;
  const meta = session.metadata || {};
  const enquiryId = meta.enquiry_id;

  if (!enquiryId) {
    console.warn('[stripe-webhook] checkout.session.completed missing enquiry_id metadata');
    return;
  }

  await markEnquiryPaid({
    tenant, config,
    enquiryId,
    paymentIntentId: session.payment_intent,
    paymentLinkId:   session.payment_link || null,
  });
}

// =============================================================================
// payment_intent.succeeded — secondary entry point
// =============================================================================
async function handlePaymentSucceeded({ event, tenant, config }) {
  const pi = event.data.object;
  const meta = pi.metadata || {};
  const enquiryId = meta.enquiry_id;

  if (!enquiryId) {
    // Likely set on checkout session, not on PI — that's fine, the
    // checkout.session.completed handler will have already processed it.
    return;
  }

  await markEnquiryPaid({
    tenant, config,
    enquiryId,
    paymentIntentId: pi.id,
    paymentLinkId:   null,
  });
}

// =============================================================================
// Idempotent: marks enquiry paid + creates booking + fires emails
// =============================================================================
async function markEnquiryPaid({ tenant, config, enquiryId, paymentIntentId, paymentLinkId }) {
  const supabase = getSupabase(tenant);

  // Idempotency check — already a booking for this PI?
  const { data: existing } = await supabase
    .from('bookings')
    .select('id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();

  if (existing) {
    console.log('[stripe-webhook] booking already exists for PI', paymentIntentId);
    return;
  }

  // Load enquiry
  const { data: enquiry, error: enqErr } = await supabase
    .from('enquiries')
    .select('*')
    .eq('id', enquiryId)
    .maybeSingle();

  if (enqErr || !enquiry) {
    console.error('[stripe-webhook] enquiry not found:', enquiryId, enqErr);
    return;
  }

  if (enquiry.status === 'paid') {
    console.log('[stripe-webhook] enquiry already marked paid', enquiryId);
    return;
  }

  // Late-payment guard: if the customer paid AFTER the captain's deposit-link
  // expiry window, refund the deposit. The captain may have given the date
  // away by now — locking it here would create a double-booking risk.
  if (enquiry.stripe_link_expires_at) {
    const expiresAt = new Date(enquiry.stripe_link_expires_at);
    if (Date.now() > expiresAt.getTime()) {
      console.warn('[stripe-webhook] late payment received after expiry', {
        enquiryId,
        expiredAt: expiresAt.toISOString(),
      });
      try {
        const stripe = getStripe(tenant);
        await stripe.refunds.create({
          payment_intent: paymentIntentId,
          reason: 'requested_by_customer',
          metadata: { reason_internal: 'deposit_link_expired_before_payment' },
        });
        console.log('[stripe-webhook] auto-refunded late payment', paymentIntentId);
      } catch (e) {
        console.error('[stripe-webhook] auto-refund failed (MANUAL INTERVENTION NEEDED):', e);
      }
      return;
    }
  }

  // Insert booking
  const { data: booking, error: bkErr } = await supabase
    .from('bookings')
    .insert({
      enquiry_id:              enquiry.id,
      customer_name:           enquiry.customer_name,
      customer_email:          enquiry.customer_email,
      customer_phone:          enquiry.customer_phone,
      charter_date:            enquiry.preferred_date,
      party_size:              enquiry.party_size,
      tour_option:             enquiry.tour_option,
      deposit_paid_cents:      enquiry.deposit_amount_cents,
      balance_due_cents:       enquiry.charter_price_cents - enquiry.deposit_amount_cents,
      currency:                enquiry.currency,
      stripe_payment_intent_id: paymentIntentId,
    })
    .select()
    .single();

  if (bkErr) {
    // The most likely failure here is the unique-index violation on
    // charter_date — meaning ANOTHER booking landed first. This is a race
    // condition we shouldn't normally hit because captain only confirms one
    // enquiry per date, but defend against it.
    console.error('[stripe-webhook] booking insert error:', bkErr);
    // Log and continue — we'd want manual intervention here.
    return;
  }

  // Update enquiry
  await supabase
    .from('enquiries')
    .update({
      status:                  'paid',
      paid_at:                 new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq('id', enquiry.id);

  // Deactivate the Payment Link so it can't be paid twice
  if (paymentLinkId || enquiry.stripe_payment_link_id) {
    try {
      await deactivatePaymentLink(tenant, paymentLinkId || enquiry.stripe_payment_link_id);
    } catch (e) {
      console.warn('[stripe-webhook] failed to deactivate Payment Link:', e.message);
    }
  }

  // Fire emails
  try {
    const msg = customerBookingConfirmedEmail({ tenantConfig: config, booking });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: booking.customer_email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[stripe-webhook] customer confirm email failed:', e);
  }

  try {
    const captainEmailAddr = getTenantEnv(tenant, 'OPERATOR_EMAIL');
    const msg = captainBookingConfirmedEmail({ tenantConfig: config, booking });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: captainEmailAddr,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[stripe-webhook] captain confirm email failed:', e);
  }
}

// =============================================================================
// charge.refunded — capture refund + free up the date if booking cancelled
// =============================================================================
async function handleChargeRefunded({ event, tenant, config }) {
  const charge = event.data.object;
  const paymentIntentId = charge.payment_intent;
  if (!paymentIntentId) return;

  const supabase = getSupabase(tenant);

  // Find booking
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .maybeSingle();

  if (!booking) {
    console.warn('[stripe-webhook] refund for unknown booking, PI:', paymentIntentId);
    return;
  }

  const fullyRefunded = charge.amount_refunded >= charge.amount;
  const newStatus = fullyRefunded ? 'refunded' : booking.status;

  await supabase
    .from('bookings')
    .update({
      status:              newStatus,
      refund_amount_cents: charge.amount_refunded,
      refund_processed_at: new Date().toISOString(),
      cancelled_at:        fullyRefunded ? new Date().toISOString() : booking.cancelled_at,
      cancelled_reason:    fullyRefunded ? 'refunded_via_stripe' : booking.cancelled_reason,
    })
    .eq('id', booking.id);

  // If the date is now free, check waitlist for that date and offer it
  if (fullyRefunded) {
    await offerSlotToTopOfWaitlist({ tenant, config, date: booking.charter_date });
  }
}

// =============================================================================
// Waitlist promotion — offer slot to position 1
// =============================================================================
async function offerSlotToTopOfWaitlist({ tenant, config, date }) {
  const supabase = getSupabase(tenant);

  const { data: top } = await supabase
    .from('waitlist')
    .select('*')
    .eq('requested_date', date)
    .eq('status', 'waiting')
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!top) return;

  const expiresAt = new Date(
    Date.now() + (config.waitlistOfferExpiryHours || 24) * 60 * 60 * 1000
  );

  await supabase
    .from('waitlist')
    .update({
      status:                  'notified',
      notified_at:             new Date().toISOString(),
      notification_expires_at: expiresAt.toISOString(),
    })
    .eq('id', top.id);

  const baseUrl = process.env[`${tenant.toUpperCase().replace(/-/g,'_')}_PUBLIC_BASE_URL`] || 'https://bookitmalta.com';
  const claimUrl = `${baseUrl}/api/waitlist-claim?token=${top.notification_token}&tenant=${tenant}`;

  try {
    const msg = customerWaitlistOfferEmail({
      tenantConfig: config,
      waitlistEntry: top,
      claimUrl,
    });
    await sendEmail({
      tenantSlug: tenant,
      tenantConfig: config,
      to: top.customer_email,
      subject: msg.subject,
      text: msg.text,
    });
  } catch (e) {
    console.error('[stripe-webhook] waitlist offer email failed:', e);
  }
}

// =============================================================================
// helpers
// =============================================================================
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
