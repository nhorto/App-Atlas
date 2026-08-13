// The application's own door, at the address `spec/telemetry.spec.ts` also stands up.
import express from 'express';

const app = express();

app.get('/telemetry', (_req, res) => res.json({}));

export { app };
