// The readable sliver. Two files of TypeScript in front of an application written in a
// language nothing here parses — which is the shape the hedge has to survive.
import express from 'express';

const app = express();

app.get('/session', (_req, res) => res.json({ ok: true }));

app.listen(3000);
