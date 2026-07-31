import { error } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { lookupUser } from '$lib/server/session';

/**
 * Runs before every request, pages and endpoints alike.
 *
 * Almost all of what it does protects nothing: hanging the signed-in visitor on
 * `locals` is a lookup, not a lock. The one line that refuses anybody is the `/admin`
 * test, and that is the only thing this file should ever be read as guarding.
 */
export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = await lookupUser(event.cookies.get('session'));

  if (event.url.pathname.startsWith('/admin') && !event.locals.user) {
    error(401, 'Sign in first');
  }

  return resolve(event);
};
