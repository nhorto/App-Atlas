/** A single-page app: the routes are in the browser, not on the file system.
 *
 * Nothing here answers a URL that a file name declares, so none of the door detectors
 * fire — and this used to land under "Code other code imports", with every component in
 * it listed as the public API nobody imports. */
import { Dashboard } from './Dashboard';

export function App() {
  return <Dashboard />;
}
