// directus, in miniature: `api/src/app.ts` puts `authenticate` on the whole application
// with a single `app.use`, and App Atlas reported it as the lock on five Fastify routes
// belonging to the mock license server in `tests/` — a program directus does not ship.
//
// A catch-all covers a door whatever its address turns out to be (#172), and that
// quietly included the addresses of a different program. This file is the catch-all;
// `tests/mock-license-server/src/routes.ts` is the door it must not reach (#250).
import express from 'express';

import { authenticate } from './authenticate.js';

const app = express();

app.use(authenticate);

app.get('/admin/settings', (_req, res) => res.json({}));

export { app };
