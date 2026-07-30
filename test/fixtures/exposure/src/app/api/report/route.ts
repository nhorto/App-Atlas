import type { Session } from 'next-auth';
import { prisma } from '../../../lib/db';

/**
 * Imports from the same auth package the sign-in door does, and checks nothing. The
 * package alone must never be the reason a route is excused — this one belongs in the
 * list a reader actually reads.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { session?: Session; page: string };
  await prisma.visit.create({ data: { page: body.page } });
  return Response.json({ ok: true });
}
