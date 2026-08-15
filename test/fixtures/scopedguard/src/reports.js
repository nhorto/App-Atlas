// The same shape one level out, and the reason it is a separate file.
//
// Here the registration is at module scope with an inline handler, so the id
// `guessHandlerId` can offer is the *file* — which is not the handler either, and which
// #255 marks as a scope for exactly that reason. But the weak rule underneath
// deliberately reads it anyway: "the check and the door are in one file" is poor
// evidence and it is not *no* evidence, so it grades `likely` rather than refusing.
//
// The check is called *inside* the inline handler on purpose. That is the case
// `guardConfidence`'s own comment says this rule exists to pay for — a check inside an
// inline handler cannot be told from one called inside the handler beside it, because
// `ctx.enclosing` collapses both to the same node. Written in the argument list instead
// it would be read by `middlewareGuards`, which never consults an id, and the fixture
// would pass whatever `guardConfidence` did.
const express = require('express');

const app = express();

function refuseAnonymous(req, res) {
  if (!req.headers.authorization) {
    res.status(401).send('sign in first');
    return true;
  }
  return false;
}

app.get('/reports', (req, res) => {
  if (refuseAnonymous(req, res)) return;
  res.json([]);
});

module.exports = { app };
