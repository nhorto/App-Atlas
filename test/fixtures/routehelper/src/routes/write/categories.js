'use strict';

// `require('express').Router()` with no name bound in between — the spelling fourteen of
// NodeBB's route modules use, and the one that used to leave this file's router unknown.
const router = require('express').Router();
const controllers = require('../../controllers');
const middleware = require('../../middleware');

const { setupApiRoute } = require('../helpers');

module.exports = function () {
	// Assembled once and spread into every call, which is how NodeBB writes the checks on
	// its own admin API — `const middlewares = [middleware.ensureLoggedIn, …]` and then
	// `setupApiRoute(router, 'get', '/analytics', [...middlewares], controller)`. The name
	// never appears in the argument list as written, so reading it means resolving the
	// local the spread came from.
	const middlewares = [middleware.ensureLoggedIn];

	setupApiRoute(router, 'get', '/:cid', controllers.categories.get);
	setupApiRoute(router, 'put', '/:cid', [...middlewares], controllers.categories.update);
	setupApiRoute(router, 'delete', '/:cid', [middleware.ensureLoggedIn], controllers.categories.remove);
	return router;
};
