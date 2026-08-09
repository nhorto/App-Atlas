import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Nest's answer to `[AllowAnonymous]`, which Nest does not have.
 *
 * Opting a route out of a globally applied guard is conventionally written as a guard
 * that permits everything, so this is spelled identically to a lock and only the body
 * tells them apart. twentyhq/twenty uses one of these 27 times.
 */
@Injectable()
export class PublicEndpointGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

/** A real check: it looks at the request and can say no. */
@Injectable()
export class RealAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.headers.authorization) {
      return false;
    }
    return true;
  }
}

/**
 * The name trap. `Public` is in it and it is a genuine check — which is why this rule
 * reads the body and never the identifier.
 */
@Injectable()
export class PublicApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return Boolean(request.headers['x-api-key']);
  }
}
