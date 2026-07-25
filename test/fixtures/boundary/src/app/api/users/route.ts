import { auth } from '@clerk/nextjs/server';
import { prisma } from '../../../lib/db';
import { sendWelcome } from '../../../lib/email';

export async function GET() {
  const users = await prisma.user.findMany();
  return Response.json(users);
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const body = (await request.json()) as { email: string };
  const user = await prisma.user.create({ data: { email: body.email } });
  await sendWelcome(body.email);
  return Response.json(user);
}
