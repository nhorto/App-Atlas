import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// The shape #221 exists for: a real check wearing the app's own suffix. Nothing here may
// stop this being read as a lock.
export function authAdminApi(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
