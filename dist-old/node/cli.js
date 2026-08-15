#!/usr/bin/env node
/**
 * @fileoverview Everything that has to happen before the first import.
 *
 * The command itself is `main.ts`. This file exists because two of the things App
 * Atlas must get right happen *earlier than any module it loads*, and an ESM import is
 * hoisted above every statement written beside it — so neither could live in the
 * command without being too late to work.
 *
 * 1. **Node's version.** `engines` says 22.5 and means it: the atlas is kept in the
 *    SQLite that ships inside Node, which is what makes installing App Atlas free of
 *    anything that has to compile (M1). `npx` and `npm install` do not enforce
 *    `engines`, so without this the floor was announced by a `node:sqlite` stack trace
 *    (#112).
 *
 * 2. **Node's warning about its own experiment.** `node:sqlite` is marked
 *    experimental, so every command opened with two lines about somebody else's
 *    roadmap before App Atlas said anything at all (#114).
 *
 * The rules live in `preflight.ts` — which imports nothing, from anywhere, so
 * importing it here cannot pull in the module it is guarding against.
 */
import { nodeIsTooOld, silenceSqliteWarning, tooOldMessage } from './preflight.js';
if (nodeIsTooOld(process.versions.node)) {
    process.stderr.write(tooOldMessage(process.versions.node));
    process.exit(1);
}
silenceSqliteWarning();
// Dynamic on purpose: a static import would be hoisted above both guards, which is
// exactly the bug this file exists to prevent.
await import('./main.js');
//# sourceMappingURL=cli.js.map