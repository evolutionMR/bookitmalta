// api/stripe-webhook.js
//
// POST /api/stripe-webhook?tenant=<slug>
//
// Stripe webhook receiver. The `tenant` query param tells us which Stripe
// account is sending the event (so we can pick the right webhook secret
// for signature verification).
//
// Events handled:
//   • checkout.session.completed              — Payment Link sync path (cards)
//   • checkout.session.async_payment_succeeded — Payment Link async (SEPA, BACS)
//   • payment_intent.succeeded                — fallback for direct PaymentIntents
//   • charge.refunded                         — partial or full refund
//   • payment_intent.payment_failed           — log + ignore (customer retries)
//
// Note: checkout.session.completed fires BEFORE async payments clear, so we
// gate on session.payment_status === 'paid'. The async_payment_succeeded
// event delivers the actual booking creation for delayed-payment methods.
// The Stripe webhook destination must subscribe to async_payment_succeeded
// for this to fire — see fast-follow task #64.
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
      case 'checkout.session.async_payment_succeeded':
        // Delayed payment method (SEPA, BACS) finally cleared. Same booking
        // logic as the sync path — markEnquiryPaid is idempotent so safe to
        // call even if checkout.session.completed already booked.
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

  // Gate on payment_status='paid'. For Stripe Payment Links with delayed
  // payment methods (SEPA, BACS), checkout.session.completed fires when the
  // customer submits but BEFORE the payment clears — payment_status is
  // 'unpaid' or 'no_payment_required' at that point. Booking the charter
  // date for an as-yet-unpaid customer would let the captain promise it
  // elsewhere if the async payment later fails.
  //
  // The async path is handled by checkout.session.async_payment_succeeded
  // which fires when the delayed payment actually clears (see switch above).
  if (session.payment_status !== 'paid') {
    console.log('[stripe-webhook] checkout.session.completed received but payment_status not paid yet — waiting for async_payment_succeeded', {
      enquiryId,
      payment_status: session.payment_status,
      session_id: session.id,
    });
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
    // Two failure modes converge here:
    //   (a) duplicate Stripe webhook delivery — both requests passed the
    //       pre-insert idempotency check before either committed. First
    //       inserted cleanly; we lost the race but a booking DOES exist
    //       for this payment_intent_id. Don't refund — the customer's
    //       payment is correctly associated with the booking the winner
    //       created.
    //   (b) genuine charter_date unique-index violation — two deposit
    //       links existed for the same date and the later customer paid
    //       after another booking inserted. Customer has been charged
    //       but has no booking. MUST refund.
    //
    // Disambiguate by re-querying bookings for this payment_intent_id.
    // (Schema-level fix is a UNIQUE constraint on stripe_payment_intent_id —
    // tracked as fast-follow task #63.)
    const { data: alreadyBooked } = await supabase
      .from('bookings')
      .select('id')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (alreadyBooked) {
      console.log('[stripe-webhook] duplicate webhook delivery — booking already exists for PI, skipping refund', {
        paymentIntentId,
        existingBookingId: alreadyBooked.id,
      });
      return;
    }

    // Genuine race-lost case (b). The customer is charged with no booking.
    console.error('[stripe-webhook] booking insert error (no existing booking for PI) — refunding customer:', bkErr);
    try {
      const stripe = getStripe(tenant);
      await stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: {
          reason_internal: 'booking_insert_race_lost',
          enquiry_id: String(enquiryId),
          original_error: (bkErr && bkErr.message) ? bkErr.message.slice(0, 200) : 'unknown',
        },
      });
      console.log('[stripe-webhook] auto-refunded after booking insert race', paymentIntentId);
    } catch (refundErr) {
      console.error('[stripe-webhook] CRITICAL: auto-refund failed after booking insert race (MANUAL INTERVENTION):', refundErr);
    }
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
      attachments: msg.attachments,   // booking.ics for Add-to-Calendar
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

  // Determine if this refund effectively cancels the booking.
  //
  // Option B refund policy advertises "refund less ~2% payment processing fee"
  // (terms.html section 5). Stripe keeps its fee on every refund, so a
  // customer-initiated cancellation will be refunded for (charge.amount -
  // stripe_fee), strictly less than charge.amount. If we only treat refunds
  // where amount_refunded >= charge.amount as "fully refunded", net-of-fee
  // refunds leave the booking stuck as 'booked' forever — the date is
  // never released and the top of the waitlist is never notified.
  // (Codex R4 finding on PR #8.)
  //
  // Fix: fetch the balance_transaction to read the exact Stripe fee, then
  // treat amount_refunded >= (charge.amount - stripe_fee) as a full
  // cancellation. Partial refunds below that threshold (e.g. captain-side
  // operator goodwill refunds of part of the booking fee) still leave the
  // date booked.
  let stripeFee = 0;
  try {
    if (charge.balance_transaction) {
      const stripe = getStripe(tenant);
      const bt = typeof charge.balance_transaction === 'string'
        ? await stripe.balanceTransactions.retrieve(charge.balance_transaction)
        : charge.balance_transaction;
      stripeFee = bt && typeof bt.fee === 'number' ? bt.fee : 0;
    }
  } catch (e) {
    console.error('[stripe-webhook] failed to fetch balance_transaction for refund fee calc:', e);
    // Conservative fallback: with stripeFee=0 only exact-amount refunds
    // trigger cancellation. Operator-side full-amount refunds still work.
  }

  const netRefundable = charge.amount - stripeFee;
  const treatAsCancelled = charge.amount_refunded >= netRefundable;
  const newStatus = treatAsCancelled ? 'refunded' : booking.status;

  console.log('[stripe-webhook] refund processed:', {
    payment_intent:     paymentIntentId,
    booking_id:         booking.id,
    charge_amount:      charge.amount,
    amount_refunded:    charge.amount_refunded,
    stripe_fee:         stripeFee,
    net_refundable:     netRefundable,
    treat_as_cancelled: treatAsCancelled,
  });

  await supabase
    .from('bookings')
    .update({
      status:              newStatus,
      refund_amount_cents: charge.amount_refunded,
      refund_processed_at: new Date().toISOString(),
      cancelled_at:        treatAsCancelled ? new Date().toISOString() : booking.cancelled_at,
      cancelled_reason:    treatAsCancelled ? 'refunded_via_stripe' : booking.cancelled_reason,
    })
    .eq('id', booking.id);

  // If the date is now free, check waitlist for that date and offer it
  if (treatAsCancelled) {
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
