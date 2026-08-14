import type { Request, Response, NextFunction } from 'express';

/** Refuses outright, so there is no question that this is a check. */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return res.status(401).send('no');
  next();
}
