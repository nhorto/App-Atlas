// The other half of Ghost's wiring, and the half that carries the prefixes App Atlas
// still cannot read. `lazyUse` is the app's own method, assigned onto the router in
// `shared/express.js`, and it forwards to `app.use(mountPath, …)`. Seven calls in Ghost
// mount everything under `/ghost/api`, so every route below is served one prefix deeper
// than App Atlas reports.
const express = require('../../../shared/express');

module.exports = () => {
  const frontendApp = express('frontend');

  frontendApp.lazyUse('/members', require('../members')());

  return frontendApp;
};
