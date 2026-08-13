const express = require('express');
const { requireAuth } = require('./guards');
const { registerBilling } = require('./billing');

// Written above the gate and called from below it — NodeBB's `setupExpressApp(app)`
// shape, parameter shadowing the module's own `app` and all. Line 10 is a smaller number
// than the gate's and runs *after* it, which is the whole reason the merge asks whether
// the gate belongs to the same run of statements before it compares two line numbers.
function wireReports(app) {
  require('./reports')(app);
}

const app = express();

require('./public')(app);
registerBilling(app);
require('./both')(app);

app.use(requireAuth);

require('./private')(app);
require('./both')(app);
wireReports(app);

module.exports = { app };
