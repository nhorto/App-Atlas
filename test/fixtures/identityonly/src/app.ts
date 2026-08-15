import express from 'express';

import { adminRouter } from './admin.js';
import authenticate from './authenticate.js';
import { itemsRouter } from './items.js';
import { telemetryRouter } from './telemetry.js';

export default function createApp() {
  const app = express();

  // Above the line, so nothing runs in front of it.
  app.use('/telemetry', telemetryRouter);

  app.use(authenticate);

  // Below it, so `authenticate` runs in front of every door in both.
  app.use('/items', itemsRouter);
  app.use('/admin', adminRouter);

  return app;
}
