/**
 * The four-line repro from #260, plus the control that identifies the mechanism.
 *
 * `api` carries a gate. Mounted bare — `app.use(api)` — the gate's pattern stays the
 * catch-all `/:path*`, and a catch-all covers every address in the program. So the two
 * routes on `app` itself came out locked by a check Express never runs for them, and
 * the count of unprotected doors read zero.
 *
 * `/favicon.ico` and `/metrics` are registered ABOVE the mount on purpose. Express
 * matches and answers them before it ever reaches `app.use(api)`, so there is no
 * ordering under which the gate applies to them.
 */
import express from 'express';
import { requireSession } from './require-session.js';
import { adminRouter } from './admin.js';

const app = express();
const api = express.Router();

// On `app`, not on `api`. Nothing checks these.
app.get('/favicon.ico', (_req, res) => res.status(404).end());
app.get('/metrics', (_req, res) => res.json({}));

api.use(requireSession);
api.get('/items', (_req, res) => res.json([]));

// A router mounted BENEATH the gated one still inherits the gate. This is the half a
// fix must not break: `reports` never names a check of its own.
api.use('/reports', adminRouter);

app.use(api);

export { app };
