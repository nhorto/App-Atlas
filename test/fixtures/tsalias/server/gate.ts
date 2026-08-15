// Named after what it does to the request, like every real middleware — so nothing in
// the guard vocabulary matches it and the only evidence is the body (#261).
import type { NextFunction, Request, Response } from 'express';

export function handleTeamHeaders(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers['x-team-token']) {
    res.status(403).end('{"error":"unauthorized"}');
    return;
  }
  next();
}
