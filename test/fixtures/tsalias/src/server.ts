// The check arrives through a tsconfig path alias, which is how a great deal of
// TypeScript is written. `@server` is not an npm scope; it is this repo's own
// `server/` directory, and reading it as a package made the body unreadable (#274).
import express from 'express';

import { handleTeamHeaders } from '@server/gate.js';

const app = express();

app.get('/teams', handleTeamHeaders, (_req, res) => res.json([]));
app.get('/health', (_req, res) => res.send('ok'));

app.listen(3000);
