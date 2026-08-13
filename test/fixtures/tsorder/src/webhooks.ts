import express from 'express';

// Mounted above the gate. Nothing in this file mentions the check, which is the whole
// reason the mount's line has to be read rather than this file's.
export const webhooks = express.Router();

webhooks.post('/stripe', (req, res) => res.json({ received: true }));
