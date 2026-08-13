// The other container the routes arrive in: a bare array handed straight to
// `strapi.server.routes(...)`, with the handler a list of functions rather than a name.
// This is how `packages/core/upload/server/src/middlewares/upload.ts` serves uploaded
// files, and `auth: false` is the author writing down that the door is open on purpose.
export default ({ strapi }: { strapi: any }) => {
  strapi.server.routes([
    {
      method: 'GET',
      path: '/uploads/(.*)',
      handler: [range, koaStatic(strapi.dirs.static.public)],
      config: { auth: false },
    },
    // A method shorthand, which is how `core/src/middlewares/public.ts` writes the
    // redirect at the root of every Strapi site. It has no initializer, so resolving the
    // property to its value finds nothing and the door was silently dropped.
    {
      method: 'GET',
      path: '/',
      handler(ctx: any) {
        ctx.redirect('/admin');
      },
      config: { auth: false },
    },
  ]);
};

declare const range: unknown;
declare function koaStatic(dir: string): unknown;
