// The incidental door, and the whole point of the fixture: one small Express panel
// beside a service whose routes go unread. Before #271 this single route was enough to
// suppress the hedge entirely, and the map reported "the one route has an auth check" —
// a true sentence about `panel.js`, presented as a sentence about the application.
const express = require('express');

const app = express();

app.get('/panel/status', requireAuth, (_req, res) => res.json({ ok: true }));

function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).send('no');
  next();
}

app.listen(3001);
