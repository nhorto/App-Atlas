// directus wraps its middleware before exporting it, so the name the app imports resolves
// to a call rather than to a function. Here for the same reason it is there: to keep the
// fixture's shape the shape the defect was found in.
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export default asyncHandler;
