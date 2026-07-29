import { prisma } from '../../lib/db';

/**
 * A page, and still not the harmless kind: it writes to the database on render and
 * nothing checks who asked for it. "It is only a page" must not excuse this one.
 */
export default async function AdminPage() {
  await prisma.visit.create({ data: { page: 'admin' } });
  return <main>Admin</main>;
}
