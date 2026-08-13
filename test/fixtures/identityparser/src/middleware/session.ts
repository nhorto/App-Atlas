// directus's `authenticate`, near enough verbatim — the largest false lock in the corpus.
//
// Its own docstring says what it is: verify the token and assign the user to `req`. An
// anonymous caller carries no token, the verification block is skipped on `if (token)`,
// the request keeps the default accountability, and it calls `next()`. It refuses
// nobody, and `app.use(authenticate)` puts it in front of 241 of directus's 253 doors.
//
// Wrapped in `asyncHandler`, as directus wraps it, so the function that decides is an
// argument rather than the export.
import type { NextFunction, Request, Response } from 'express';

import { asyncHandler } from '../asyncHandler.js';
import { accountabilityForToken } from '../token.js';

export const handler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    req.accountability = await accountabilityForToken(req.token);
  } catch (err) {
    res.clearCookie('session');
    // A re-throw from a catch reports a failure it was handed; it is not a decision
    // about a caller, and it is only ever reached by somebody who *did* present a token.
    throw err;
  }

  return next();
};

export default asyncHandler(handler);
