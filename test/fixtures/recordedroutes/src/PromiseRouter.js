// Parse Server's shape, near enough verbatim. `route` calls nothing — it writes the door
// down — and `mountOnto`, forty lines later, is where express first hears about any of
// it. #229's rule asks whether the helper's own body registers a route, so all 84 of
// parse-server's doors were invisible to it.
//
// Neither method is evidence alone. Applications push objects into arrays constantly,
// and a loop that calls `app[verb](x.path, …)` says only that *something* in that array
// becomes a route. Over the same field, on the same class, they say what this class
// records is what it serves.
const express = require('express');

class PromiseRouter {
  constructor() {
    this.routes = [];
    this.mountRoutes();
  }

  mountRoutes() {}

  route(method, path, ...handlers) {
    switch (method) {
      case 'POST':
      case 'GET':
      case 'PUT':
      case 'DELETE':
        break;
      default:
        throw 'cannot route method: ' + method;
    }

    let handler = handlers[0];

    this.routes.push({
      path: path,
      method: method,
      handler: handler,
    });
  }

  // The replay. The address the framework is given is the recorded element's own `path`,
  // which is what separates this from any other loop that happens to call something.
  mountOnto(expressApp) {
    this.routes.forEach(route => {
      const method = route.method.toLowerCase();
      expressApp[method].call(expressApp, route.path, route.handler);
    });
    return expressApp;
  }

  expressRouter() {
    return this.mountOnto(express.Router());
  }
}

module.exports = { PromiseRouter };
