import { error } from '@sveltejs/kit';

/** Reads whoever the session cookie belongs to. Answers a question; refuses nobody. */
export async function lookupUser(token: string | undefined) {
  return token ? { id: token } : null;
}

/**
 * The check itself, wearing the name of a lookup.
 *
 * Every page that needs a signed-in visitor calls this and contains no check of its
 * own, so the 401 below is the only evidence anywhere in the repo that any of them are
 * protected — and no list of well-known guard names would ever have found it.
 */
export function getSessionUser(locals: App.Locals) {
  if (!locals.user) error(401, 'Not signed in');
  return locals.user;
}
