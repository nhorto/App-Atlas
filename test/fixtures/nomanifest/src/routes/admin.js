'use strict';

const express = require('express');

module.exports = function (app, middleware, controllers) {
	const router = express.Router();
	app.use('/admin', router);

	router.get('/dashboard', middleware.requireAuth, controllers.dashboard);
};
