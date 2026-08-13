import express from 'express';

export const adminApi = express.Router();

adminApi.get('/settings', (req, res) => res.json({}));
