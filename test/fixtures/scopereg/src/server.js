// One function holding the whole program — mastodon's `startServer`, which is 1,317
// lines containing four route registrations, the WebSocket handler, and a check that
// stands in front of exactly one thing that is not a route.
//
// Every registration here is an inline arrow, and an arrow is not a node in the atlas.
// So "which function answers this door" walks up past it and answers `startServer` for
// all of them — and `authorizeListAccess`, written in the same function, has that same
// node for its own. Four doors and one check, all pointing at one id.
const express = require('express');

const { AuthenticationError, db, collect, onSubscribe, requireAdmin } = require('./support');

async function startServer() {
  const app = express();
  const api = express.Router();

  // Registered on the bare app, above the router and its gate. Nothing stands in front
  // of these three, and a Prometheus endpoint reported as locked is the expensive way to
  // be wrong about that.
  app.get('/favicon.ico', (_req, res) => res.status(404).end());
  app.get('/metrics', (_req, res) => res.json(collect()));
  app.get('/health', (_req, res) => res.send('ok'));

  // A door that calls its check inside its own handler. This is what refusing a
  // scope-derived id gives up: `requireAdmin` is written in this door's handler and in
  // no other, and `ctx.enclosing` collapses that to the same `startServer` as the line
  // above it, so the two cannot be told apart from an id alone. Reported open, and
  // wrongly — the recoverable direction, and the reason `handlerSpan` exists.
  app.get('/admin/keys', (req, res) => {
    requireAdmin(req);
    res.json(db.keys());
  });

  // The genuine router-level check, which arrives by a different road: `api.use` names
  // the router it guards, so the gate is a fact about `api` and not about whatever
  // function the line was typed inside. This is the half that has to survive.
  //
  // Mounted under a prefix, which the fixture needs rather than merely prefers. A bare
  // `app.use(api)` leaves the gate's pattern a catch-all, and a catch-all covers every
  // address in the program — including the three above, on a different router. That is
  // its own question; here it would only stop this file from being able to ask this one.
  api.use(requireSession);
  api.get('/items', (_req, res) => res.json(db.items()));
  app.use('/api', api);

  function requireSession(req, res, next) {
    if (!req.headers.authorization) return res.status(401).send('sign in first');
    next();
  }

  // The check, and the whole of the trouble. It authorizes a subscription to one
  // timeline list. It is not in front of `/metrics`, it is not in front of anything with
  // an address, and its only call site is below.
  const authorizeListAccess = async (listId, req) => {
    const rows = await db.lists(listId, req.accountId);
    if (rows.length === 0) throw new AuthenticationError('List not found');
  };

  onSubscribe((params, req) => {
    if (params.kind === 'list') return authorizeListAccess(params.list, req);
    return Promise.resolve();
  });

  return app;
}

module.exports = { startServer };
