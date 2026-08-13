import { app } from './app.js';

// Registered on the imported app from another file, with no mount to read. Its position
// against the gate cannot be established from a line, so it keeps the check — see the
// correction on #201. The CommonJS spelling of this, where the app is handed over by an
// argument on a line anyone can point at, is read: see `cjsorder`.
app.get('/reports', (req, res) => res.json([]));
