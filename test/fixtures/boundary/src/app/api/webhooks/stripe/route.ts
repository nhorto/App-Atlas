import Stripe from 'stripe';
import { prisma } from '../../../../lib/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature') as string;
  const raw = await request.text();
  const event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET as string);

  if (event.type === 'checkout.session.completed') {
    await prisma.order.create({ data: { userId: 'u_1', amount: 100 } });
  }
  return new Response('ok');
}
