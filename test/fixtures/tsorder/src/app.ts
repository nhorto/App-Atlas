import express from 'express';
import { admin } from './admin.js';
import { requireAuth } from './guards.js';
import { webhooks } from './webhooks.js';

const app = express();

app.get('/health', (_req, res) => res.send('ok'));
app.use('/webhooks', webhooks);

app.use(requireAuth);

app.get('/items', (_req, res) => res.json([]));
app.use('/admin', admin);

export { app };
