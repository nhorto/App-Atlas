import express from 'express';
import { formatName, userStore } from '../lib/format';
import type { User } from '../models/user';

export function registerRoutes(app: express.Application): void {
  app.get('/me', (_req, res) => {
    const user: User = { id: '1', email: 'a@b.c', role: 'member' };
    res.json({ name: formatName(user) });
  });
  app.get('/users/:id', async (req, res) => {
    res.json(await userStore.load(req.params.id));
  });
}
