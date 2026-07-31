import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  return { owner: locals.user?.id ?? null, bottles: [] };
};

/**
 * Two form posts at one address, and neither of them checks anybody.
 *
 * `default` answers a plain POST to `/cellar`; `delete` answers `/cellar?/delete`. A
 * reader looking for the app's writes will not find either of them by searching for
 * the word "route".
 */
export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    return { added: String(form.get('name')) };
  },
  delete: async ({ request }) => {
    const form = await request.formData();
    return { removed: String(form.get('id')) };
  },
};
