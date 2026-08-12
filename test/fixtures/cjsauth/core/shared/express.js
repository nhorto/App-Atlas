// A wrapper around express that adds one method. `lazyUse` is a mount — it calls
// `app.use` with the same path it was handed — but nothing about the *name* says so,
// and a detector that guessed from names would mount whatever anybody called `lazyUse`.
const express = require('express');

module.exports = (name) => {
  const app = express();
  app.set('name', name);

  app.lazyUse = function lazyUse(mountPath, router) {
    app.use(mountPath, router);
  };

  return app;
};
