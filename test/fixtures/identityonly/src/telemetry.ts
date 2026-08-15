import { Router } from 'express';

// Mounted *above* `authenticate`, the way directus mounts `/deployments/webhooks` at
// `src/app.ts:322` and authenticates at 328. Nothing runs in front of this one at all,
// and the difference between it and `/items` is the whole point of the split.
export const telemetryRouter = Router();

telemetryRouter.post('/', (_req, res) => res.json({ ok: true }));
