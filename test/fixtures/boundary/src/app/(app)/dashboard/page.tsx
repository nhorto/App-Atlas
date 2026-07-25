import { auth } from '@clerk/nextjs/server';
import { countUsers } from '../../../lib/db';

export default async function DashboardPage() {
  const { userId } = await auth();
  const total = await countUsers();
  return (
    <main>
      {userId}: {total}
    </main>
  );
}
