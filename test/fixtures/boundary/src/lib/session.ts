import { auth } from '@clerk/nextjs/server';
import { prisma } from './db';

/**
 * The shape almost every real app uses: the check lives in a helper, and the route
 * that runs it contains no auth call of its own.
 */
export async function requireOwner(orderId: string): Promise<boolean> {
  const { userId } = await auth();
  if (!userId) return false;
  const count = await prisma.order.count({ where: { id: orderId, userId } });
  return count > 0;
}
