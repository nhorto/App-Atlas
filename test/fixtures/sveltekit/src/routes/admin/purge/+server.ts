import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Nothing in this file checks anybody. The only thing standing in front of it is the
 * `/admin` test in `hooks.server.ts` — which is a real check, written a long way from
 * here, and never more than likely.
 */
export const DELETE: RequestHandler = async () => {
  return json({ purged: true });
};
