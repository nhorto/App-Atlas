import type { Request, Response } from 'express';

/** The refusal, behind a name that carries no status code with it. */
export function notAllowed(_req: Request, res: Response): void {
  res.status(403).end();
}
