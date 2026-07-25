/**
 * @fileoverview The shared Prisma client.
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function countUsers(): Promise<number> {
  return prisma.user.count();
}
