// parse-server's `connection` door, in the shape that made it matter: the same address
// is declared in `spec/ParseWebSocketServer.spec.js` *and* in
// `src/Adapters/WebSocketServer/WSAdapter.js`, so the door has four sites and two of them
// are the application's.
//
// A test standing an address up beside the app is not evidence about that address. One
// site outside the suite is the whole answer, and the flag has to come back off.
import express from 'express';

const harness = express();

harness.get('/events', (_req, res) => res.json([]));

export { harness };
