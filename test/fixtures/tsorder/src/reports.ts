import { app } from './app.js';

// Registered on the imported app from another file, with no mount to read. Its position
// against the gate cannot be established, so it keeps the check — see the correction on
// #201, and #206 for the direction of the import that would settle it.
app.get('/reports', (req, res) => res.json([]));
