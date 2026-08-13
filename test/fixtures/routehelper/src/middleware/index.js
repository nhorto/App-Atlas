'use strict';

const middleware = module.exports;

/**
 * The trap this fixture exists to hold shut.
 *
 * The name matches the guard-prefix rule (`authenticate` + a capital), it is injected
 * into every list the page helper builds, and it refuses nobody: an anonymous caller
 * falls through to `setAuthVars` and `next()`. NodeBB's real one behaves exactly this
 * way, and it stands on `/login`.
 */
middleware.authenticateRequest = async function (req, res, next) {
	if (req.headers.authorization) {
		req.uid = await lookup(req.headers.authorization);
	}
	setAuthVars(req);
	next();
};

/** This one does refuse, and is written at the call site rather than injected. */
middleware.ensureLoggedIn = function (req, res, next) {
	if (!req.uid) return res.status(401).json({ error: 'not-authorised' });
	next();
};

async function lookup(token) {
	return token ? 1 : 0;
}

function setAuthVars(req) {
	req.loggedIn = Boolean(req.uid);
}
