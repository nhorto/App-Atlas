// The case that must survive, and the reason the rule is about *what a handlerId means*
// rather than about scopes being shared.
//
// Here the check is written in the door's argument list, where whoever declared the route
// put it. That is ordinary evidence and is read by `middlewareGuards`, which has nothing
// to do with the handler id — so narrowing what an id proves must not touch it.
const express = require('express');

const { requireAdmin } = require('./requireAdmin');

function mountAdmin() {
  const app = express();

  app.get('/admin/settings', requireAdmin, (_req, res) => res.json({}));

  // A second door in the same scope with no check of its own. Before #255 it inherited
  // `requireAdmin` from the line above simply by sharing an enclosing function.
  app.get('/admin/ping', (_req, res) => res.end('pong'));

  return app;
}

module.exports = { mountAdmin };
