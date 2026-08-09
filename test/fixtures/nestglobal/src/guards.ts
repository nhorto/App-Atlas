import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

// The immich shape: the global guard reads per-route metadata, and a route that never
// declared any is refused. The decorators on the controllers apply no guard at all.
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    if (!Reflect.getMetadata('auth-options', handler)) {
      throw new Error(`Route ${handler.name} does not declare auth options`);
    }
    const req = context.switchToHttp().getRequest();
    return Boolean(req.user);
  }
}

@Injectable()
export class MaintenanceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    return !req.app.locals.maintenance || Boolean(req.user?.admin);
  }
}

// The #152 sentinel, wired globally: providing this as APP_GUARD locks nothing, and
// counting it would put a lock's name on every door in the fixture.
@Injectable()
export class EveryoneGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
