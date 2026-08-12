// The shape Ghost mounts its admin API with (#204), and the reason App Atlas reported
// 263 of 263 routes unprotected: the check is a `require(...)` expression rather than a
// name, the router beside it is a factory call on another `require(...)`, and the check
// is itself a factory — so what guards the route is one call deeper than the argument.
const express = require('express');

const backendApp = express();

backendApp.use('/ghost', require('../../services/auth/session').createSessionFromToken(), require('../admin')());

module.exports = backendApp;
