// directus, in miniature: `api/src/app.ts` puts `authenticate` on the whole application,
// and App Atlas reports it as the lock on five Fastify routes that belong to the mock
// license server in `tests/` — a program directus does not ship.
//
// That is why the count of set-aside doors is taken over doors and not over open-door
// verdicts. A verdict is only ever reached for a door with nothing on it, so a set-aside
// built from verdicts would keep every guarded route the suite declares, and directus's
// denominator would still be five doors too big.
import express from 'express';

import { authenticate } from './authenticate.js';

const app = express();

app.use(authenticate);

app.get('/admin/settings', (_req, res) => res.json({}));

export { app };
