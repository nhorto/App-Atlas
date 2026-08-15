// The two hops that assemble the head of every address in `documents.ts`, and the
// reason `unreadHead` is the honest answer: `use('/', …)` normalises `documents.list`
// to `/documents.list`, and `mount('/api', …)` puts `/api` back on the front. Neither
// hop is read by this pass, so the head is not knowable here.
import Koa from 'koa';
import mount from 'koa-mount';
import Router from 'koa-router';

import documents from './documents.js';
import { auth } from './middleware.js';

const api = new Router();
api.use('/', documents.routes());

// The named-route form: koa-router takes an optional name *before* the path, told apart
// by the second argument also being a string. Getting this wrong would record the name
// as the address.
api.get('user.profile', '/users/:id', auth(), async (ctx) => {
  ctx.body = { id: ctx.params.id };
});

const app = new Koa();
app.use(mount('/api', api.routes()));
app.listen(3000);
