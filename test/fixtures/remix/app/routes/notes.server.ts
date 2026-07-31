/**
 * Sits in `routes/` and is not a route: it exports no loader, no action and no page.
 * Reading its name as an address would put `/notes/server` on the map, and nothing
 * answers there.
 */
export async function listNotes(): Promise<string[]> {
  return [];
}
