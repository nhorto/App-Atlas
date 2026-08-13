// Handed the app by a `require(…)(app)` written above the gate. Nothing in this file
// mentions the gate, and nothing in it could.
module.exports = (app) => {
  app.get('/health', (_req, res) => res.send('ok'));
};
