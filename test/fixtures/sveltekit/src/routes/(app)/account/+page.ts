import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * A *universal* load: the server runs it for the first request and the browser runs it
 * for every navigation after that. The redirect below is routing, not a lock — which
 * is why this page is reported as unprotected however much it looks guarded.
 */
export const load: PageLoad = async ({ data }) => {
  if (!data?.user) redirect(303, '/login');
  return data;
};
