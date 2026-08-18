// The application's own door, so the fixture has something to still be right about.
import express from 'express';

const app = express();

app.get('/real', (_req, res) => res.json({ ok: true }));

export { app };
