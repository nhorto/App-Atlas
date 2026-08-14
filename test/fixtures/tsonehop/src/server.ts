/**
 * parse-server's `FilesRouter.js`, which names its check in the argument list — a
 * position `middlewareGuards` already reads precisely. Nothing here is a hard analysis
 * problem; the only reason these doors reported no check is that no name matched.
 */
import express from 'express';
import * as Middlewares from './middlewares.js';

const app = express();

// Reads: gains `handleParseHeaders`, whose refusal is one call away.
app.post('/files/:filename', Middlewares.handleParseHeaders, (_req, res) => res.json({}));
app.delete('/files/:filepath', Middlewares.handleParseHeaders, (_req, res) => res.json({}));

// Reads: gains `promiseEnforceMasterKeyAccess`, which refuses in its own body.
app.get('/schemas', Middlewares.promiseEnforceMasterKeyAccess, (_req, res) => res.json([]));

// Must not read. The refusal belongs to what the factory returns.
app.get('/profile', Middlewares.createHeaderChecker(), (_req, res) => res.json({}));

// Must not read. Two hops is further than the rule goes, on purpose.
app.get('/health', Middlewares.prepareRequest, (_req, res) => res.json({ ok: true }));

// Must not read. It decorates the request and lets everybody through.
app.get('/ping', Middlewares.attachRequestId, (_req, res) => res.send('pong'));

app.listen(3000);
