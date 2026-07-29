import express from 'express';
import morgan from 'morgan';

import { api } from './routes';

const app = express();

// None of these may become a router. The first is a call rather than a name, and the
// second is a name — but one belonging to somebody else's package, so there is no file
// of ours behind it to mount.
app.use(express.json());
app.use(morgan);

app.use('/api/v1', api);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

export { app };
