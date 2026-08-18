// The case that must survive: a test standing an address *up*, which is Sails' shape and
// what #247 is built around. It hands `get` a handler, so something is registered, and
// the door is real for the length of a run — reported, and marked as the suite's.
import express from 'express';

const app = express();

app.get('/res_redirect/1', (_req, res) => res.redirect('/'));

export { app };
