// mastodon's streaming server, in miniature.
//
// One long function holds every route registration, a WebSocket handler, and — five
// hundred lines below the routes in the real thing — a helper called
// `authorizeListAccess`, which authorizes access to a *timeline list* inside a
// subscription. It is in front of none of these routes.
//
// An inline arrow is not a node in the atlas, so `ctx.enclosing` can only answer with the
// function the registration sits inside. That made the door's "handler" this whole scope,
// and `guardConfidence`'s first line then read the helper as a check written on the
// door's own handler. All four came out locked, `/metrics` among them, and the headline
// read `every one of the 5 routes has an auth check` for a server where none of them has.
const express = require('express');

function startServer() {
  const app = express();

  app.get('/favicon.ico', (_req, res) => res.status(404).end());

  app.get('/api/v1/streaming/health', (_req, res) => res.end('OK'));

  app.get('/metrics', metrics.requestHandler);

  const authorizeListAccess = async (listId, req) => {
    if (!req.accountId) {
      throw new Error('Not authorized');
    }
    return listId;
  };

  wss.on('connection', (ws, req) => {
    subscribe(ws, params => authorizeListAccess(params.list, req));
  });

  return app;
}

declareGlobals();

module.exports = { startServer };
