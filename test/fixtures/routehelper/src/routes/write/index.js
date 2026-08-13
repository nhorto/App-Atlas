'use strict';

// The mount host is a router this file was handed, not one it built, so the prefix it
// writes here cannot be attached to anything by reading this file alone. NodeBB does the
// same thing — `Write.reload = async (params) => { const { router } = params; … }` — and
// it is why the addresses under it are unreadable rather than wrong.
module.exports = function (params) {
	const { router } = params;
	router.use('/api/v3/categories', require('./categories')());
};
