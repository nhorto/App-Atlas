import type { PageServerLoad } from './$types';

/** The front page. Anybody may read it, and nothing here pretends otherwise. */
export const load: PageServerLoad = async () => {
  return { bottles: 12 };
};
