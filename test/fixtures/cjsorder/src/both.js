// Handed the app twice, once on each side of the gate. Express answers with the first
// registration it matches, so the copy above the gate is the one a stranger reaches.
module.exports = (app) => {
  app.get('/both', (_req, res) => res.json([]));
};
