// The case the abstention was written for, kept alongside the case it broke (#201).
//
// This module does not build a router. It is handed `app` — the same object the gate was
// written on — so the name really does mean the same router here, the mount graph has no
// edge to follow, and the check must stand. If the #276 rule were "a name in another
// module never counts", this door would go wrongly red.
import type express from 'express';

export function registerReports(app: express.Router): void {
  app.get('/reports/summary', (_req, res) => res.json([]));
}
