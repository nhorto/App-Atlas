'use server';

import { prisma } from '../lib/db';

/** Creates an order. Called straight from the browser — no auth check anywhere. */
export async function createOrder(userId: string, amount: number) {
  return prisma.order.create({ data: { userId, amount } });
}
