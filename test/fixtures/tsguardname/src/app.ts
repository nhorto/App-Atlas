import express from 'express';
import { adminApi } from './admin.routes.js';
import { authApi } from './auth.api.js';
import { authAdminApi, requireAuth } from './guards.js';
import { createLocalAuthRouter } from './providers.js';

const app = express();

// The gate first, so nothing here turns on registration order (#201) — this fixture is
// about which names are checks at all.
app.use(requireAuth);

// A mount. `authApi` is the router these doors hang off, not a lock on them.
app.use('/auth', authApi);

// One call, two arguments, one of each: the check stays and the router goes.
app.use('/admin', requireAuth, adminApi);

// A router the mount reader cannot resolve: assigned, not declared, and built by a
// factory. Nothing but the name is left to go on.
let authRouter;
authRouter = createLocalAuthRouter('local');
app.use('/login', authRouter);

// Still a check, and still `likely` — the prefix rule #221 added.
app.get('/posts', authAdminApi, (req, res) => res.json([]));

export { app };
