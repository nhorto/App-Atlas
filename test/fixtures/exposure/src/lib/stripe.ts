import Stripe from 'stripe';

/** The SDK instance the webhook route verifies signatures with. */
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
