// The same pairing as `test/events.test.ts`, with the two files the other way round.
//
// `spec/` sorts before `src/`, so this declaration is the one the merge sees first and the
// flag goes on before the application's own file arrives to take it off again. The pair in
// `test/` covers the opposite order. Both are here because a negative check found that one
// of them alone proves nothing: with the merge rule deleted, a fixture that only ever met
// the application first still passed.
import express from 'express';

const harness = express();

harness.get('/telemetry', (_req, res) => res.json({}));

export { harness };
