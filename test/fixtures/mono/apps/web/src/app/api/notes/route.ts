/** @fileoverview Notes, readable by anyone at all. */
export async function GET() {
  return Response.json({ notes: [] });
}
