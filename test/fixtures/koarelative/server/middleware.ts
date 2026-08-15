// The check outline's routes carry. It is a factory — the middleware is what `auth()`
// returns — which is why the name in the argument list is the only evidence this pass
// has for it. Reading the body of what a factory builds is #265, not this change.
import type { Context, Next } from 'koa';

export function auth() {
  return async function authMiddleware(ctx: Context, next: Next) {
    if (!ctx.headers.authorization) {
      ctx.throw(401, 'Authentication required');
    }
    await next();
  };
}
