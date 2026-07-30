import express from 'express';

import { admin } from './admin.routes';
import { open } from './public.routes';

const app = express();

app.use('/admin', admin);
app.use('/open', open);

// On the root app, and so genuinely open to everyone.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

export { app };
