// The mock server's route, in a `tests/` directory under a filename that says nothing.
// It will come out wearing the application's `authenticate` — a lock from a different
// program — which is exactly the claim this door must not be counted on.
import express from 'express';

const mock = express();

mock.get('/license/:key', (_req, res) => res.json({ ok: true }));

export { mock };
