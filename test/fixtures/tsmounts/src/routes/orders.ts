import express from 'express';

// The name the file declares is not the name anybody imports — `export default` is how
// most Express route modules are written, and it leaves nothing to match on.
const router = express.Router();

router.get('/', (_req, res) => res.json([]));
router.post('/:id/refund', (_req, res) => res.json({ ok: true }));

export default router;
