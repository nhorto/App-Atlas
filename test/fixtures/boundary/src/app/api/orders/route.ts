import { stripe } from '../../../lib/payments';
import { prisma } from '../../../lib/db';
import { requireOwner } from '../../../lib/session';

// Not one auth call and not one Stripe import in this file, yet the route is both
// protected and a payments integration. One hop of indirection either way.
export async function DELETE(request: Request) {
  const orderId = new URL(request.url).searchParams.get('id') as string;
  if (!(await requireOwner(orderId))) return new Response('Forbidden', { status: 403 });

  await stripe.refunds.create({ payment_intent: orderId });
  await prisma.order.delete({ where: { id: orderId } });
  return new Response(null, { status: 204 });
}
