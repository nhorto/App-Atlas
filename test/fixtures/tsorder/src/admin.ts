import express from 'express';

// Mounted below the gate, and equally silent about it.
export const admin = express.Router();

admin.get('/settings', (req, res) => res.json({}));
