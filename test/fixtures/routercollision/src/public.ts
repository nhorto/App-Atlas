// A different router that happens to share a name, which is the whole fixture. Nothing
// here imports, mentions or is mounted under `requireAuth`; `router` is simply what
// everybody calls the thing routes hang off.
import express from 'express';

const router = express.Router();

router.get('/public/health', (_req, res) => res.send('ok'));

export default router;
