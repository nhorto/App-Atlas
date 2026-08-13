'use strict';

// The trap, copied from `packages/plugins/users-permissions/server/src/routes/content-api/auth.js`.
//
// `rateLimit` sits in `config.middlewares`, not `config.policies`, and it stands on the
// door that hands out sessions. Reading the middleware list would put a lock on `/auth/local`
// — which is NodeBB's `authenticateRequest` on `/login` in a second framework (#229).
// Strapi has already separated the two keys; only `policies` carries a refusal contract.
module.exports = {
  type: 'content-api',
  routes: [
    {
      method: 'POST',
      path: '/auth/local',
      handler: 'auth.callback',
      config: {
        middlewares: ['plugin::users-permissions.rateLimit'],
        prefix: '',
      },
    },
    {
      method: 'POST',
      path: '/auth/forgot-password',
      handler: 'auth.forgotPassword',
      config: {
        middlewares: ['plugin::users-permissions.rateLimit'],
        prefix: '',
      },
    },
  ],
};
