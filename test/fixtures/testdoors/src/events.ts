// The application's own door, and the address the suite below re-declares.
import express from 'express';

const app = express();

app.get('/events', (_req, res) => res.json([]));

export { app };
