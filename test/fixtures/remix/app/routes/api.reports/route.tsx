import { json } from '@remix-run/node';
import { listReports } from './queries.server';

/** In a route folder the address is the folder's name, and `route` is its module. */
export async function loader() {
  return json({ reports: await listReports() });
}
