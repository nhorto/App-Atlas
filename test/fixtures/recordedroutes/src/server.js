// The mount, and the reason every address above wears an ellipsis: `mountPath` is a
// deployment setting that lives in another file and can be overridden by anybody running
// this. `/users` is a tail, not an address.
const express = require('express');
const { UsersRouter } = require('./Routers/UsersRouter');

function start(options) {
  const api = express();
  api.use(new UsersRouter().expressRouter());

  const app = express();
  app.use(options.mountPath, api);
  return app;
}

module.exports = { start };
