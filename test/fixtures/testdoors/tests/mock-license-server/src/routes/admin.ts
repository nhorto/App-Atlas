// directus, near enough verbatim. `tests/mock-license-server/` is a whole Fastify service
// stood up for the e2e run — real routes, real checks, and none of it directus. Its own
// source calls these "test-only routes for sandbox setup".
//
// Two things this file is here to hold down. The filename is `admin.ts`, so nothing but
// the directory says "test"; and the route carries a check, which is why the count of
// set-aside doors is taken over doors rather than over open-door verdicts — a verdict is
// only ever reached for a door with no guard on it.
import type { FastifyInstance } from 'fastify';

import { requireLicense } from '../hooks/require-license.js';

export async function adminRoute(app: FastifyInstance) {
  app.get('/:license_key', { preHandler: requireLicense }, async (request) => {
    return { license: request.params };
  });
}
