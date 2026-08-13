// Reached only through `wireReports`, which is written above the gate and called below
// it. Its position is real but not readable from a line number, so the check stands.
module.exports = (app) => {
  app.get('/reports', (_req, res) => res.json([]));
};
