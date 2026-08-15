// The gate. Written on *this* module's router, and it reaches this module's doors and
// whatever is mounted beneath them — not the identically-named router next door (#276).
import express from 'express';

const router = express.Router();

router.use(requireAuth);

router.get('/admin/purge', (_req, res) => res.send('purged'));

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.headers.authorization) {
    res.status(401).send('no');
    return;
  }
  next();
}

export default router;
