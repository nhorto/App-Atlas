'use strict';

// The manifest is in `install/`, not here — NodeBB's layout, where `package.json` is
// copied into place during setup and a checked-out clone has none at the root. The
// evidence that this is Express is the line below, not anybody's dependency list.
const express = require('express');

module.exports = function (app, middleware, controllers) {
	const router = express.Router();
	app.use('/api', router);

	router.get('/config', controllers.getConfig);
	router.post('/self', middleware.requireAuth, controllers.updateSelf);
};
