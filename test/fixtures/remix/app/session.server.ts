import { redirect } from '@remix-run/node';

/** Reads whoever the session cookie belongs to. Answers a question; refuses nobody. */
export async function getUserId(request: Request): Promise<string | null> {
  return /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
}

/**
 * The Remix idiom, and the only place in this app where a caller is turned away. Every
 * protected loader calls it and contains no check of its own, so a reader searching a
 * route file for the word "auth" finds nothing at all.
 */
export async function requireUserId(request: Request): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) throw redirect('/login?redirectTo=/notes');
  return userId;
}
