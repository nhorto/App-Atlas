import { prisma } from '../../../lib/db';
import { withTeam } from '../../../lib/guards';

export const GET = withTeam(async () => {
  const orders = await prisma.order.findMany();
  return Response.json(orders);
});
