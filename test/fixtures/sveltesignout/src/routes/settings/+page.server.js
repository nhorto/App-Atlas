import { error, redirect } from '@sveltejs/kit';

export function load({ locals }) {
  if (!locals.user) redirect(302, '/login');
}

export const actions = {
  // The door #186 is about: deleting your own cookie requires nothing to be true
  // first, and this was the single entry on sveltejs/realworld's worry list.
  logout: async ({ cookies, locals }) => {
    cookies.delete('jwt', { path: '/' });
    locals.user = null;
  },

  // A real check beside it, so a rule that excused the whole file would show.
  save: async ({ locals, request }) => {
    if (!locals.user) error(401);
    return { saved: (await request.formData()).get('name') };
  },
};
