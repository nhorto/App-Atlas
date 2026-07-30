import type { NextFunction, Request, Response } from 'express';

/** Express middleware. Turns strangers away. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    res.status(401).json({ error: 'who are you?' });
    return;
  }
  next();
}

/** A Nest guard, which is a class rather than a function. */
export class SessionGuard {
  canActivate(): boolean {
    return false;
  }
}
