import express from 'express';

// Deliberately open, and mounted as a sibling of the locked router so a rule that reads
// `admin.use(requireAuth)` as "the app is protected" has to get this one wrong.
const open = express.Router();

open.get('/status', (_req, res) => res.json({ ok: true }));

export { open };
