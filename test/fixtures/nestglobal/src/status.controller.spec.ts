import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

// The standard testing pattern (#180): a module wired with a mocked global guard. Its
// body decides something, so nothing but the zone of this file keeps it off the map —
// and if it ever reaches a route, a test's stand-in has locked the application.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    return req.headers['x-test-user'] === 'yes';
  }
}

export const testingModule = {
  providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
};
