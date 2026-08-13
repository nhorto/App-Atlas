// A router factory reached through `require('../admin')()`, with no name anywhere for
// the mount resolver to match on.
const express = require('express');
const mw = require('./middleware');

module.exports = function adminApp() {
  const router = express.Router();

  router.get('/users', mw.authAdminApi, (req, res) => res.json([]));
  router.post('/users', mw.authorList, (req, res) => res.json({ created: true }));
  router.delete('/users/:id', (req, res) => res.status(204).end());

  return router;
};
