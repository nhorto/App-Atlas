import express from 'express';

import { requireAuth } from './guards';

const admin = express.Router();

// The same line means two different things depending on what it is written on. On the
// root app it is the whole application; here it is this router and nothing else, and
// which one it is cannot be read from this file — the mount is in `server.ts`.
admin.use(requireAuth);

admin.post('/purge', (_req, res) => res.json({ ok: true }));

export { admin };
