import { prisma } from '../../../lib/db';

/** Nothing checks this, and nothing explains why. The whole point of the headline. */
export async function GET(): Promise<Response> {
  const rows = await prisma.visit.findMany();
  return Response.json(rows);
}
