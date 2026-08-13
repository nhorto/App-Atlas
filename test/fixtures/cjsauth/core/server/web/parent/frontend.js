// The other half of Ghost's wiring: a mount through the app's own `lazyUse`, with the
// prefix written as an imported constant rather than a literal. Both have to be readable
// or the routes under here are reported at an address two segments short of the one they
// answer at.
const express = require('../../../shared/express');
const { BASE_API_PATH } = require('../../../shared/url-utils');

module.exports = () => {
  const frontendApp = express('frontend');

  frontendApp.lazyUse(BASE_API_PATH, require('../members')());

  return frontendApp;
};
