// An RPC-style Koa API: the paths carry no leading slash, and the prefix arrives from
// two mounts in another file. outline writes 192 of its 226 routes this way (#269).
import Router from 'koa-router';

import { auth } from './middleware.js';

const router = new Router();

// Checked, and the check sits in the argument list where `middlewareGuards` already
// reads it — so these arrive with their auth column filled in, not as a blanket
// "unprotected" the way #139's netbox did.
router.post('documents.list', auth(), async (ctx) => {
  ctx.body = [];
});

router.post('documents.info', auth(), async (ctx) => {
  ctx.body = {};
});

// Public on purpose, and the point of the fixture: outline's `shares.sitemap` and
// `notifications.unsubscribe` are real unauthenticated doors sitting in a file whose
// other routes are all checked. If a guard pools across the file or the router, this is
// the route that goes quietly and wrongly green.
router.get('documents.public', async (ctx) => {
  ctx.body = {};
});

// The absolute form in the same file, which must keep its address rather than being
// swept into the unread-head spelling with the rest.
router.get('/documents/health', async (ctx) => {
  ctx.body = 'ok';
});

export default router;
