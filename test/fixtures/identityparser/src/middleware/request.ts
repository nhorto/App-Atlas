// NodeBB's `authenticateRequest` — the trap, and the reason this rule is only ever asked
// in one direction.
//
// It has a bare `return;`, so structurally it is indistinguishable from a refusal. It is
// not one: the inner `authenticate()` hands back `true` for an anonymous caller, and the
// early return is reached only when something has already responded. Asked "is this a
// refusal?" from shape alone, any rule says yes — and it stands on `/login`.
//
// So the rule proves *always continues* and never its negation. This function fails that
// proof, which means nothing is concluded and the claim is left exactly as it was.
import type { NextFunction, Request, Response } from 'express';

import { parse } from '../token.js';

export const authenticateRequest = async (req: Request, res: Response, next: NextFunction) => {
  if (!(await parse(req, res))) {
    return;
  }

  next();
};
