// Sails, near enough verbatim. `test/unit/virtual-request-interpreter.test.js` stands an
// app up and hangs a route off it per case it wants to exercise; twenty-nine of the
// thirty doors App Atlas reported for the whole framework came out of two files like
// this one, and every one of them landed on the screen that exists to find open doors.
import express from 'express';

const app = express();

app.get('/res_sending_back_a_number/1', (_req, res) => res.send(42));
app.get('/res_sending_back_a_string/1', (_req, res) => res.send('hi'));

// The address deliberately carries the word, in a case shape nobody would call a
// directory: `sessionTest` is not the segment `test`, and this door is still the suite's.
app.get('/sessionTest', (_req, res) => res.json({}));

export { app };
