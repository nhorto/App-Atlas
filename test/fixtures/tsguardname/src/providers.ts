import express from 'express';
import type { Router } from 'express';

/** A router built behind a factory, so the mount reader has no declaration to follow. */
export function createLocalAuthRouter(name: string): Router {
  const router = express.Router();
  router.post(`/${name}`, (req, res) => res.json({ name }));
  return router;
}
