/** @fileoverview The server the suite makes requests against. Nobody deploys it. */
const express = require('express');
const app = express();
app.get('/echo', (req, res) => res.json(req.query));
app.post('/upload', (req, res) => res.sendStatus(200));
app.listen(3000);
