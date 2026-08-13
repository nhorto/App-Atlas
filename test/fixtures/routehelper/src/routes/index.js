'use strict';

const express = require('express');
const helpers = require('./helpers');
const controllers = require('../controllers');

// The router arrives from the caller, exactly as NodeBB's does. Nothing here says what
// it is mounted under, and in practice it is mounted at the root — so the fragment
// written below is the address, and an ellipsis in front of it would be describing a
// prefix that is usually empty.
exports.setup = function (app) {
	helpers.setupPageRoute(app, '/login', controllers.login);
	helpers.setupPageRoute(app, '/register', controllers.register);
	helpers.setupPageRoute(app, '/reset/:code?', [], controllers.reset);

	// Written out longhand, and must keep behaving exactly as it did.
	app.get('/plain', controllers.plain);

	const writeApi = express.Router();
	require('./write')(writeApi);
	app.use(writeApi);
};
