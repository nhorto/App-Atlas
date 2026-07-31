import { getSessionUser } from '$lib/server/session';
import type { PageServerLoad } from './$types';

/** Not one auth call in this file: `getSessionUser` does the refusing, one hop away. */
export const load: PageServerLoad = async ({ locals, params }) => {
  const user = getSessionUser(locals);
  return { id: params.id, owner: user.id };
};
