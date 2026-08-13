// The second control, and the one that makes the *address* rule load-bearing.
//
// `Telemetry` never reaches that rule: its replay calls `sink.send(…)`, and `send` is not
// an HTTP verb, so the loop is refused a step earlier. This class gets past that — it
// replays over a field and calls `store.get(…)`, which is spelled exactly like a route
// registration — and is refused only because what it hands over is the element's `key`
// rather than its `path`. Caches, queues and stores are full of `.get(…)` in a loop.
class ResponseCache {
  constructor() {
    this.entries = [];
  }

  remember(method, path, body) {
    this.entries.push({ method: method, path: path, body: body });
  }

  warm(store) {
    this.entries.forEach(entry => {
      store.get(entry.key);
    });
  }
}

module.exports = { ResponseCache };
