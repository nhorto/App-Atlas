import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';

// A middleware that actually refuses. Its door must not join the identity-only count, or
// the count would be measuring "has middleware" rather than "has middleware that admits
// everyone".
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

export const adminRouter = Router();

adminRouter.get('/settings', requireAdmin, (_req, res) => res.json({}));
