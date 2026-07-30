import { auth } from '@clerk/nextjs/server';

/**
 * The dominant shape in production Next.js and tRPC: the route exports the *result*
 * of a wrapper, and the check happens inside the wrapper.
 */
export function withTeam(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const { userId } = await auth();
    if (!userId) return new Response('Unauthorized', { status: 401 });
    return handler(request);
  };
}
