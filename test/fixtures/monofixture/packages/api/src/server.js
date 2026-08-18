/** @fileoverview The API somebody deploys. */
const express = require('express');
const app = express();
app.get('/orders', (req, res) => res.json([]));
module.exports = app;
