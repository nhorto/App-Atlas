// The other half of the rule, and the reason it needs both halves.
//
// This class records `{ method, path }` objects built from its own parameters into a
// field, in a method whose name reads even better than `route`. Nothing ever serves them
// — the loop that reads them back posts them to a metrics sink. Applications are full of
// this, which is why "a function that assigns its parameters into a structure something
// else later registers" is not the rule: it would put two doors on the map that nobody
// can knock on, and #246 found the same shape in Strapi's own admin, where dozens of
// outbound fetch configs are written as `{ method, path }`.
class Telemetry {
  constructor() {
    this.samples = [];
  }

  record(method, path, ms) {
    this.samples.push({ method: method, path: path, ms: ms });
  }

  flush(sink) {
    this.samples.forEach(sample => {
      sink.send(sample.path, sample.method);
    });
  }
}

module.exports = { Telemetry };
