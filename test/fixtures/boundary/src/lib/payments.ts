import Stripe from 'stripe';

/** A configured client the rest of the app imports. Nothing here charges anybody. */
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
