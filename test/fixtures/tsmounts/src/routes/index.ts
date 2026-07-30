import express from 'express';

import ordersRouter from './orders';

const api = express.Router();

api.use('/orders', ordersRouter);

api.get('/ping', (_req, res) => res.json({ ok: true }));

export { api };
