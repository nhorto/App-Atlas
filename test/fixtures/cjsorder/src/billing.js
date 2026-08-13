// The same fact through an ordinary imported function rather than a `require` call: the
// app is still an argument, and the call still sits above the gate.
function registerBilling(app) {
  app.post('/webhooks/stripe', (_req, res) => res.send('ok'));
}

module.exports = { registerBilling };
