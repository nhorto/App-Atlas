/** @fileoverview The standalone API server. */
import express from 'express';

export const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
