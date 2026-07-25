import { prisma } from '../../../../lib/db';
import { sendWelcome } from '../../../../lib/email';

export async function GET() {
  const users = await prisma.user.findMany();
  for (const user of users) {
    await sendWelcome(user.email);
  }
  return new Response('sent');
}
