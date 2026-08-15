import express from 'express';

import admin from './admin.js';
import pub from './public.js';
import { registerReports } from './reports.js';

const app = express();

app.use(requireSession);

// Handed the guarded router as an argument, below the gate — so `/reports/summary` is
// covered by `requireSession` and must keep it.
registerReports(app);

app.use(admin);
app.use(pub);

app.listen(3000);

function requireSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.headers.cookie) {
    res.status(401).send('no');
    return;
  }
  next();
}
