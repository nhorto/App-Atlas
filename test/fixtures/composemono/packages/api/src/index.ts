/** @fileoverview The app App Atlas narrows to, which mentions no port anywhere. */
import express from 'express';

/** Starts the server. The stack it runs in is described a directory or two above. */
export function start(): void {
  const app = express();
  app.get('/health', (_req, res) => res.send('ok'));
  app.listen(3000);
}
