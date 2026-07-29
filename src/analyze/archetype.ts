/**
 * @fileoverview What kind of thing is this repo?
 *
 * The five views were built for a web app, and until now every project got them in
 * that order whether or not it had a web boundary to show. A Python scripts repo would
 * open on a nearly-empty diagram of doors it does not have, while the question it
 * actually has — how do these files fit together — sat two tabs away.
 *
 * So before any view is chosen, the atlas says what it is looking at. The archetype is
 * a fact derived from signals we already collect: the doors the boundary detectors
 * found, the zones the files fell into, and the frameworks the manifests declare. No
 * model is involved, and every verdict carries the signals that produced it, because a
 * wrong guess that shows its reasoning is a bug report and a wrong guess that hides it
 * is a mystery.
 *
 * What the archetype is allowed to do is deliberately narrow: it changes which view
 * opens first, which tabs are emphasized, and how an empty view explains itself. It
 * never hides a view, and it never changes a fact. Bespoke per-framework screens are
 * the thing this is designed to avoid — one atlas, one set of lenses, different
 * emphasis.
 */
import type { Archetype, ArchetypeVerdict, AtlasNode, EndpointMeta } from '../model/types.js';
import type { ProjectInfo } from './project.js';

/** Doors a stranger on a network can knock on. */
const NETWORK_DOORS = new Set(['http-route', 'server-action', 'webhook', 'realtime']);

/** Frameworks whose presence means someone is meant to look at this with their eyes. */
const UI_FRAMEWORKS = new Set([
  'React',
  'React Native',
  'Vue',
  'Svelte',
  'Angular',
  'Next.js',
  'Next.js App Router',
  'Next.js Pages Router',
  'Expo Router',
  'Streamlit',
  'Electron',
]);

export interface ArchetypeInput {
  project: ProjectInfo;
  nodes: AtlasNode[];
}

export function classifyArchetype({ project, nodes }: ArchetypeInput): ArchetypeVerdict {
  const doors = countDoors(nodes);
  const uiFrameworks = project.frameworks.filter((name) => UI_FRAMEWORKS.has(name));
  const hasUiFiles = project.files.some((file) => file.zone === 'ui');
  const bin = readBin(project.packageJson);
  const exported = countExports(nodes);

  const because: string[] = [];

  // A screen is a way a person gets in, so a file-routed native app counts here even
  // though nothing in it answers a URL.
  if (doors.network > 0 || doors.screen > 0) {
    const wantsEyes = doors.screen > 0 || hasUiFiles || uiFrameworks.length > 0;
    if (wantsEyes) {
      if (doors.screen > 0) because.push(plural(doors.screen, 'screen'));
      if (doors.network > 0) because.push(plural(doors.network, 'way in over the network', 'ways in over the network'));
      if (uiFrameworks.length > 0) because.push(uiFrameworks.join(', '));
      return verdict('web-app', 'An app with a front end', because);
    }
    because.push(plural(doors.network, 'way in over the network', 'ways in over the network'));
    if (project.frameworks.length > 0) because.push(project.frameworks.slice(0, 3).join(', '));
    because.push('no interface files');
    return verdict('service', 'A service other things call', because);
  }

  // No network doors and nobody looking at it: the remaining question is whether this
  // runs, or gets imported.
  if (doors.cli > 0 || bin.length > 0) {
    if (doors.cli > 0) because.push(plural(doors.cli, 'command-line entry point'));
    if (bin.length > 0) because.push(`${plural(bin.length, 'command')} in package.json`);
    if (doors.scheduled > 0) because.push(plural(doors.scheduled, 'scheduled job'));
    because.push('nothing answers a URL');
    return verdict('pipeline', 'Something you run', because);
  }

  if (doors.scheduled > 0) {
    because.push(plural(doors.scheduled, 'scheduled job'));
    because.push('nothing answers a URL');
    return verdict('pipeline', 'Something you run', because);
  }

  if (exported > 0) {
    because.push(plural(exported, 'exported name'));
    because.push('no doors of any kind');
    return verdict('library', 'Code other code imports', because);
  }

  // Nothing decisive. Say so rather than picking the nearest neighbour: the map is
  // still true, and claiming to know what this is would be the first lie in it.
  if (project.files.length > 0) because.push(plural(project.files.length, 'source file'));
  because.push('no doors and nothing exported');
  return verdict('unknown', 'A collection of code', because);
}

interface DoorCounts {
  network: number;
  screen: number;
  cli: number;
  scheduled: number;
}

function countDoors(nodes: AtlasNode[]): DoorCounts {
  const counts: DoorCounts = { network: 0, screen: 0, cli: 0, scheduled: 0 };
  for (const node of nodes) {
    if (node.kind !== 'endpoint') continue;
    const kind = (node.meta as unknown as EndpointMeta).endpointKind;
    if (NETWORK_DOORS.has(kind)) counts.network++;
    else if (kind === 'screen') counts.screen++;
    else if (kind === 'cli') counts.cli++;
    else if (kind === 'cron' || kind === 'queue') counts.scheduled++;
  }
  return counts;
}

/**
 * Exports are counted over files rather than functions, because a library is a set of
 * modules someone imports and one module re-exporting forty names is still one door.
 */
function countExports(nodes: AtlasNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const names = (node.meta as { exportedNames?: string[] }).exportedNames;
    if (names && names.length > 0) total++;
  }
  return total;
}

function readBin(pkg: Record<string, unknown> | null): string[] {
  const bin = pkg?.bin;
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') return Object.keys(bin as Record<string, unknown>);
  return [];
}

function verdict(archetype: Archetype, label: string, because: string[]): ArchetypeVerdict {
  return { archetype, label, because };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
