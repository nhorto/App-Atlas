// Call sites with a literal method and a `/…` path, so the only thing standing between
// these and the map is the replay loop being read rather than assumed.
const { Telemetry } = require('./Telemetry');

const telemetry = new Telemetry();

telemetry.record('GET', '/metrics/cache', 12);
telemetry.record('POST', '/metrics/flush', 40);

module.exports = { telemetry };
