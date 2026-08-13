'use strict';

// Deliberately does not require express. A helper takes the router as an argument —
// that is the point of it — so the file carrying the most routes in the project is the
// one with the least reason to name the framework. NodeBB's real helpers.js imports
// winston and two of its own modules, and nothing else.
const helpers = module.exports;
const middleware = require('../middleware');

// router, name, middlewares(optional), controller
helpers.setupPageRoute = function (...args) {
	const [router, name] = args;
	let middlewares = args.length > 3 ? args[args.length - 2] : [];
	const controller = args[args.length - 1];

	middlewares = [middleware.authenticateRequest, ...middlewares];

	// One call, two doors: the page and the JSON the page fetches. The second address
	// appears nowhere in the calling file.
	router.get(name, middlewares, helpers.tryRoute(controller));
	router.get(`/api${name}`, middlewares, helpers.tryRoute(controller));
};

// router, verb, name, middlewares(optional), controller
helpers.setupApiRoute = function (...args) {
	const [router, verb, name] = args;
	const controller = args[args.length - 1];
	router[verb](name, helpers.tryRoute(controller));
};

helpers.tryRoute = function (controller) {
	return async function (req, res, next) {
		try {
			await controller(req, res);
		} catch (err) {
			next(err);
		}
	};
};
