// The mock server's route, in a `tests/` directory under a filename that says nothing.
//
// It was coming out wearing the application's `authenticate` — a lock from a different
// program, on a door that program has never served — and reporting it is the failure
// this project is built against: a claim nobody can tell is wrong by looking at it. The
// honest answer here is that nothing was examined, because the only checks that could
// have been are the suite's own, and those were filtered out in #25.
import express from 'express';

const mock = express();

mock.get('/license/:key', (_req, res) => res.json({ ok: true }));

export { mock };
