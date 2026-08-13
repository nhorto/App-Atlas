'use strict';

// The mount host is a router this file was handed, not one it built, so nothing here says
// what it is. NodeBB does exactly this — `Write.reload = async (params) => { const
// { router } = params; … }` — and 204 of its addresses hang off it.
//
// Deliberately *not* called `router`. Spelled that way it would be recognised by
// `ROUTER_NAMES`, and the test below would pass without the rule it exists to check:
// renaming NodeBB's to `rtr` took its `/api/v3` addresses from 204 to 2. What proves this
// is a router is the argument — you cannot mount a sub-router onto something that is not
// one — and the merge drops the finding if `./categories` turns out not to build one.
module.exports = function (params) {
	const { mountPoint } = params;
	mountPoint.use('/api/v3/categories', require('./categories')());
};
