// The same shape one level out: registrations at module scope rather than inside a
// function. Here the id is the *file*, which is also not the handler — and that case
// already has a rule, deliberately graded `likely` rather than refused, because "the
// check and the door are in one file" is weak evidence and not no evidence.
//
// It is in this fixture so that narrowing the strong rule cannot quietly empty the set
// the weak one tests, which is the failure `guardConfidence` already carries a paragraph
// about: `[].every(…)` is true, so "no handler" and "the whole file" gave one answer.
const express = require('express');

const { db } = require('./support');

const app = express();

function requireSession(req, res, next) {
  if (!req.headers.authorization) return res.status(401).send('sign in first');
  next();
}

app.use(requireSession);

app.get('/settings', (_req, res) => res.json(db.settings()));

module.exports = { app };
