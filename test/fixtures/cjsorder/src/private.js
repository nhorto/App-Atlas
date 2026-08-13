// Handed the app below the gate, so the gate covers it. The line the route is written on
// is smaller than the gate's line and says nothing about either.
module.exports = (app) => {
  app.get('/items', (_req, res) => res.json([]));
};
