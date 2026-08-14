/**
 * parse-server's `src/middlewares.js`, reduced to the shapes that decide the answer.
 *
 * Nothing in this file is named like a check. That is the point: every name here says
 * what it does to the request, which is how middleware is actually named.
 */
import type { NextFunction, Request, Response } from 'express';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The refusal itself, 700 lines from its caller in the real file. */
function invalidRequest(_req: Request, res: Response): void {
  res.status(403);
  res.end('{"error":"unauthorized"}');
}

/**
 * The one-hop case. No 401 and no 403 anywhere in this body — it calls the function that
 * has them, which is why reading the body alone finds nothing.
 */
export function handleParseHeaders(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers['x-parse-application-id']) return invalidRequest(req, res);
  next();
}

/** The no-hop case: the refusal is right here, and the name still says nothing. */
export function promiseEnforceMasterKeyAccess(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-parse-master-key'] !== process.env.MASTER_KEY) {
    throw new HttpError(403, 'unauthorized: master key is required');
  }
  next();
}

/**
 * The trap, and the reason both scans are pinned to a function's own body: a factory.
 * The 403 below belongs to what this returns, and this has never turned anybody away.
 * Ghost writes `createSessionFromToken()` exactly this way.
 */
export function createHeaderChecker() {
  return function fromHeader(req: Request, res: Response, next: NextFunction): void {
    if (!req.headers.authorization) return invalidRequest(req, res);
    next();
  };
}

/** The second trap: two hops. `handleParseHeaders` is one call further in than the rule goes. */
export function prepareRequest(req: Request, res: Response, next: NextFunction): void {
  handleParseHeaders(req, res, next);
}

/** And the ordinary case — middleware that decorates a request and refuses nobody. */
export function attachRequestId(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { id: string }).id = 'r-1';
  next();
}
