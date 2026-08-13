'use strict';

const express = require('express');
const routes = require('./routes');
const instrument = require('./instrument');

const app = express();
instrument(app);
routes.setup(app);

module.exports = app;
