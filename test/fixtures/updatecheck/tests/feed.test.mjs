/**
 * The same two-file shape as the app, written in a test.
 *
 * `fetchFeedVersion` is the real helper, and the URL is a constant right here — so the
 * pairing in reach.ts finds a genuine host. It is a fixture pointing at a fixture, and
 * naming it as a company this app depends on is the #25 failure wearing a new hat.
 */
import { fetchFeedVersion } from '../scripts/ops-console/net.mjs';

const FIXTURE_FEED = 'https://feeds.example.org/fixture.json';

export async function testFeed() {
  return fetchFeedVersion(FIXTURE_FEED);
}
