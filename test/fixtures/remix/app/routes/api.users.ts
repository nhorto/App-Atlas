import { json } from '@remix-run/node';

/**
 * A resource route: a loader and no component, which makes it an API endpoint in
 * everything but name. Nothing checks who is asking.
 */
export async function loader() {
  return json({ users: [] });
}
