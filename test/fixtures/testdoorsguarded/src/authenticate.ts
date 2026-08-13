import type { NextFunction, Request, Response } from 'express';

/** The application's own lock, and the application's alone. */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    res.status(401).end();
    return;
  }
  next();
}
