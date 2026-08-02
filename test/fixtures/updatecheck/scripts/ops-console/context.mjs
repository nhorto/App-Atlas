/**
 * Builds the console's startup context.
 *
 * The URL is two hops from the call: a property of a config object imported from
 * another module, handed to a helper that is the thing holding the `fetch`.
 */
import { EXPECTED, LOCAL_PREVIEW } from './config.mjs';
import { fetchFeedVersion } from './net.mjs';

export async function buildContext() {
  const latest = await fetchFeedVersion(EXPECTED.feedLatest);
  const preview = await fetchFeedVersion(LOCAL_PREVIEW);
  return { latest, preview };
}
