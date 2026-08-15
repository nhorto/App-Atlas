import express from 'express';

import { gateStreamRequest, makeStreamGate, validateShape } from './middleware.js';

const app = express();

// Locked, by a refusal written as a type in a file with no status code.
app.get('/streaming/events', gateStreamRequest, (_req, res) => res.json([]));

// Not locked: refuses with a 400, which is not a refusal of identity.
app.post('/documents', validateShape, (_req, res) => res.json({}));

// Not locked: `makeStreamGate` is mentioned, not called, so the function that refuses is
// one this door never runs.
app.get('/reports', makeStreamGate, (_req, res) => res.json([]));

// Nothing in front of it at all, so the count has something true to sit against.
app.get('/health', (_req, res) => res.send('ok'));

app.listen(3000);
