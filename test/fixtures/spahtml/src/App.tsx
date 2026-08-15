/** The same single-page app as `spa`, with one difference: its manifest declares entry
 * points, and both of them name the built page rather than a module.
 *
 * `@directus/app` is written this way. The fields were read as "this is where you import
 * me from", so an 844-file admin interface was filed as a library and 692 of its own
 * modules became the way in (#283). */
import { Dashboard } from './Dashboard';

export function App() {
  return <Dashboard />;
}
