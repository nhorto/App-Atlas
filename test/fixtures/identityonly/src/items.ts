import { Router } from 'express';

// Nothing on any of these lines. Whether they are checked is decided entirely by what
// was registered above them in `app.ts`.
export const itemsRouter = Router();

itemsRouter.get('/', (_req, res) => res.json([]));
itemsRouter.post('/', (_req, res) => res.json({}));
itemsRouter.delete('/:pk', (_req, res) => res.json({}));
