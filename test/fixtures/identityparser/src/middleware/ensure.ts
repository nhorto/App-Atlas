// NodeBB's `ensureLoggedIn`, near enough verbatim — a real refusal, and the one this
// rule must never take away.
//
// Note what it does *not* contain: any literal 401 or 403. The refusal is a call to a
// helper, so a rule that looked for a status code would delete a true lock from 162
// NodeBB doors. What makes it a refusal is structural — a way out that does not hand
// control on.
import type { NextFunction, Request, Response } from 'express';

import { notAllowed } from '../helpers.js';

export function ensureLoggedIn(req: Request, res: Response, next: NextFunction): void {
  if (!req.loggedIn) {
    return notAllowed(req, res);
  }

  setImmediate(next);
}
