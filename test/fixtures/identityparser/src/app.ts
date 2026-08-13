// The registration that makes this matter: one `app.use` in front of everything.
import express from 'express';

import authenticate from './middleware/session.js';
import { ensureLoggedIn } from './middleware/ensure.js';
import { authenticateRequest } from './middleware/request.js';

const app = express();

// Named like a check, reads identity, refuses nobody. Withdrawn — and every door it
// covers is told that this is what stood in front of it.
app.use(authenticate);

app.get('/items', (_req, res) => res.json([]));
app.get('/activity', (_req, res) => res.json([]));

// A real refusal, written per route. Untouched.
app.get('/admin/settings', ensureLoggedIn, (_req, res) => res.json({}));

// Cannot be proven to always continue, so nothing is concluded and the name stands.
app.get('/profile', authenticateRequest, (_req, res) => res.json({}));

export { app };
