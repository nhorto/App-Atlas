// The same shape one level out, and the reason it is a separate file.
//
// Here the registrations are at module scope, so the id `guessHandlerId` can offer is the
// *file* — which is not the handler either, and which #255 marks as a scope for exactly
// that reason. But the weak rule underneath deliberately reads it anyway: "the check and
// the door are in one file" is poor evidence and it is not *no* evidence, so it grades
// `likely` rather than refusing.
//
// Narrowing that rule to the same set the strong one uses empties it for every
// module-scope door, and `[].every(…)` is true — which puts the `handlerIds.size > 0`
// check back to guarding nothing, the precise failure it carries a paragraph about and
// the one that reported `mux.Handle("/debug/vars", expvar.Handler())` as protected.
//
// Measured before this file was written: making that narrowing passes the whole suite
// and silently drops `gateKeeper` from the door below.
const express = require('express');

const app = express();

function gateKeeper(req, res, next) {
  if (!req.headers.authorization) return res.status(401).send('sign in first');
  next();
}

app.get('/reports', gateKeeper, (_req, res) => res.json([]));

module.exports = { app, gateKeeper };
