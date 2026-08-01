/**
 * What the ops console expects to find when it starts up.
 *
 * The update feed lives on a host the company runs. It is a string constant here and
 * nothing fetches it in this file, which is exactly the shape that used to report
 * "no outside service" for an app that phones home on every launch (#89).
 */
export const EXPECTED = {
  feedLatest: 'https://updates.fabispulse.com/latest.json',
  minimumVersion: '2.1.0',
};

/** The dev server, when one is running. Loopback is not an outside service. */
export const LOCAL_PREVIEW = 'http://127.0.0.1:5173/health';
