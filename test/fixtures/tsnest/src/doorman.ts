import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Matches no auth vocabulary at all. The only reason to believe it is a check is that it
 * throws a 401, which is a fact about the code rather than a fact about the name.
 */
@Injectable()
export class Doorman implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    if (!req.headers.authorization) {
      throw new HttpException('Not authorized.', HttpStatus.UNAUTHORIZED);
    }
    next();
  }
}

/**
 * Attached by the same two calls, in the same file, by the same team. Refuses nobody —
 * so counting it would make the security screen worthless by making it always green.
 */
@Injectable()
export class Tally implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    console.log(req.method, req.url);
    next();
  }
}
