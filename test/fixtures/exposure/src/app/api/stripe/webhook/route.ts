import { prisma } from '../../../../lib/db';
import { stripe } from '../../../../lib/stripe';

/**
 * Checks nobody's session and is not open: the signature is the lock (#122).
 *
 * `constructEventAsync` recomputes an HMAC of the raw body against the endpoint secret
 * and throws when it does not match, so nothing reaches the write below without the
 * shared secret. Reported as a door nothing checks — in the tool's most alarming words,
 * on a payment endpoint — until webhook verification counted as the check it is.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!signature) return Response.json({ error: 'missing signature' }, { status: 400 });

  const event = await stripe.webhooks.constructEventAsync(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);

  await prisma.payment.create({ data: { id: event.id, kind: event.type } });
  return Response.json({ received: true });
}
