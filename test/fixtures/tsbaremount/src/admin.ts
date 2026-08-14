import express from 'express';

/**
 * Mounted under the gated router and naming no check of its own. Its door is guarded
 * only because `api` is, which is the coverage a fix for #260 must leave intact.
 */
export const adminRouter = express.Router();

adminRouter.get('/daily', (_req, res) => res.json({}));
