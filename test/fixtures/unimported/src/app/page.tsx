/** @fileoverview The home page — the one door this fixture app opens. */
import { connect } from '../lib/db';

export default async function Home() {
  const rows = await connect();
  // Loaded only when somebody asks for it. Nothing else in the app mentions this file,
  // and a reader told it was abandoned would be deleting a working feature.
  const { lazyThing } = await import('../lib/lazy-target');
  return { rows, extra: lazyThing() };
}
