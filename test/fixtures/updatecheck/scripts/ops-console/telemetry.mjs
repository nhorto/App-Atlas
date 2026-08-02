/** The shapes that were already found, kept here so a fix cannot quietly lose them. */
const MIRROR = 'https://mirror.fabispulse.com/status';

export async function ping() {
  // A literal, straight into the call. This has always worked.
  await fetch('https://telemetry.fabispulse.com/ping', { method: 'POST' });
  // A constant one line up, which had not.
  return fetch(MIRROR);
}
