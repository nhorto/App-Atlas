'use strict';

// `require('express').Router()` with no name bound in between — the spelling fourteen of
// NodeBB's route modules use, and the one that used to leave this file's router unknown.
const router = require('express').Router();
const controllers = require('../../controllers');

const { setupApiRoute } = require('../helpers');

module.exports = function () {
	setupApiRoute(router, 'get', '/:cid', controllers.categories.get);
	setupApiRoute(router, 'put', '/:cid', controllers.categories.update);
	setupApiRoute(router, 'delete', '/:cid', controllers.categories.remove);
	return router;
};
