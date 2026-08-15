import type { NextFunction, Request, Response } from 'express';

import asyncHandler from './async-handler.js';

// Reads who is calling and refuses nobody. A request with no token does not get a 401 —
// it gets the public role and is handed on, which is why every door behind this one is
// unprotected and why saying "nothing checks this" about them is the wrong sentence.
export const handler = async (req: Request, _res: Response, next: NextFunction) => {
  req.accountability = await accountabilityForToken(req.headers.authorization);
  return next();
};

async function accountabilityForToken(token: string | undefined) {
  return { user: token ? 'someone' : null, role: token ? 'member' : 'public' };
}

export default asyncHandler(handler);
