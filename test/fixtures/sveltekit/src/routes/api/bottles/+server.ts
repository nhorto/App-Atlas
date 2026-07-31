import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Open on purpose: the catalogue is public. */
export const GET: RequestHandler = async () => {
  return json({ bottles: [] });
};

/** The write beside it does check, in the handler itself. */
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) error(401, 'Not signed in');
  const body = await request.json();
  return json({ added: body.name }, { status: 201 });
};
