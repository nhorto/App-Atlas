// This file contains no 401 and no 403. That is the fixture: every rule in `auth.ts` was
// looking for a status code that mastodon's streaming server never writes here.
import type { NextFunction, Request, Response } from 'express';

import { AuthenticationError, RequestError } from './errors.js';

// The refusal, inside a promise executor — which runs *during* the call, so it is this
// function's own refusal and not something it merely produced.
const accountFromRequest = (req: Request): Promise<string> =>
  new Promise((resolve, reject) => {
    const token = req.headers.authorization;
    if (!token) {
      reject(new AuthenticationError('Missing access token'));
      return;
    }
    resolve(token);
  });

// Named so that no vocabulary in this project can recognise it. If this door comes back
// locked it is because the body was read, which is the only thing the test is asking.
export const gateStreamRequest = (req: Request, _res: Response, next: NextFunction): void => {
  // Forwards the decision rather than making it — `.catch` is deliberately not counted
  // as this function's own refusal, and the door is locked by what `accountFromRequest`
  // does, one call away.
  accountFromRequest(req)
    .then(() => next())
    .catch((err) => next(err));
};

// Refuses with a 400. Not a refusal of *identity*, and the rule must decline it — by
// reading the status on the class, not by reading the word `Error`.
export const validateShape = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.body) {
    throw new RequestError('Missing body');
  }
  next();
};

// A factory whose product refuses. #261 pinned the scan to a function's own statements
// exactly so this could not lend its lock to a bare mention, and that rule still stands:
// a `return` is not an argument, so nothing in #265 can reach it.
export function makeStreamGate() {
  return function builtGate(req: Request, _res: Response, next: NextFunction): void {
    if (!req.headers.authorization) {
      throw new AuthenticationError('Missing access token');
    }
    next();
  };
}
