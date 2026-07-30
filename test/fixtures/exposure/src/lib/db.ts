import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function recordVisit(page: string): Promise<void> {
  await prisma.visit.create({ data: { page } });
}
