import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The group's layout. SvelteKit runs this before rendering any page inside `(app)` —
 * but not before an endpoint, and the group's name is not part of any address, so App
 * Atlas deliberately reports nothing on the strength of it.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) redirect(303, '/login');
  return { user: locals.user };
};
