import express from 'express';

// A router whose name the prefix rule accepts and whose spelling gives nothing away:
// `authApi` is `auth` + a capital, and does not end in `Router`. Only the fact that this
// module builds a router can settle it.
export const authApi = express.Router();

authApi.post('/logout', (req, res) => res.status(204).end());
authApi.post('/password/reset', (req, res) => res.json({ ok: true }));
