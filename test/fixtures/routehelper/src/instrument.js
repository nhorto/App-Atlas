'use strict';

/**
 * The near-miss, kept because it is real code from a real project.
 *
 * Apostrophe monkeypatches Express to log every route, and the shim is written in the
 * same idiom as the helper above — rest arguments, the handler taken off the end, the
 * path first, and a route method called with it. It registers nothing new: it forwards
 * to the method it replaced. Reading it as a route helper would invent doors at whatever
 * addresses happened to be passed through it.
 *
 * Two things keep it out. The route method is called on a name this function closed over
 * rather than on one of its own parameters, and the assignment target is a computed
 * member rather than a plain property.
 */
module.exports = function instrument(app) {
	['get', 'post', 'put', 'delete'].forEach((method) => {
		const superMethod = app[method].bind(app);
		app[method] = (path, ...args) => {
			const middleware = args.slice(0, args.length - 1);
			const fn = args[args.length - 1];
			superMethod(path, ...middleware, (req, ...rest) => {
				console.log(`${method} ${path}`);
				return fn(req, ...rest);
			});
		};
	});
};
