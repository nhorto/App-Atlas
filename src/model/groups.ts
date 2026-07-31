/**
 * @fileoverview Groups with a shape — the unit the words layer should describe (issue #49).
 *
 * From the [bake-off](../../docs/BAKEOFF.md): CodeBoarding's prose beat ours on our own
 * fixture, and the reason was not the model. We ran the same family of model. They
 * cluster first, statically, and then ask for a description of *a group that already has
 * a shape*. We asked for a description of one file at a time and stacked the answers up.
 *
 * A file often has nothing to say about itself. `src/lib/db.ts` exports a client. What is
 * worth saying is that six route handlers go through it to reach Postgres and nothing
 * else in the repo touches the database directly — and that is a fact about a *group*,
 * not about a file.
 *
 * So this computes the groups, and it computes them the way the rest of the tool computes
 * everything: from facts already in the atlas, with no model involved.
 *
 * **The cut is a cut of the folder tree.** Not a similarity metric, not a community
 * detection pass over the import graph, and — deliberately — not a list of framework
 * folder names. Every language the tool reads puts related code in the same directory,
 * because that is what directories are for, and a cut of that tree is the one grouping
 * that means the same thing in a Next.js repo, a Django repo and a Go module. It is also
 * the one a reader can check: they can see the folders.
 *
 * **Shape is the other half, and it is the half we were missing.** A group carries what
 * it holds, what it owns (doors, tables, outside services), how its doors are guarded,
 * and — the part no prompt in this codebase had before — *which other groups it hands off
 * to and which hand off to it*. That last one is what lets a sentence say
 * "browser → route handler → shared client → Stripe" instead of describing four folders
 * one at a time and leaving the arrows to the reader.
 *
 * Nothing here creates an atlas node. Groups are a view over the graph, computed on
 * demand, exactly like `boundary.ts` and `personal.ts`.
 */
import type {
  AtlasEdge,
  AtlasNode,
  CodeSite,
  EndpointMeta,
  ModuleMeta,
  OpenKind,
  ServiceMeta,
  StoreMeta,
  Zone,
} from './types.js';

/**
 * A folder big enough to be worth splitting into its subfolders.
 *
 * Below this, a group is already small enough that naming its parts adds nothing: eight
 * files is a paragraph's worth of thing. Above it, "your `src` folder" is not a group,
 * it is the app.
 */
const SPLIT_ABOVE = 12;

/**
 * How many groups the splitting is allowed to produce.
 *
 * A budget on how finely *we* cut, and deliberately not a ceiling on the answer. A repo
 * that already has twenty top-level packages — every Go repo of any size — gets twenty
 * groups, because its own top level is not something this tool chose and truncating it
 * would drop a real part of the architecture on the floor. What the budget stops is us
 * opening folder after folder until the overview is the file list again with longer names.
 *
 * The root bucket can also push the count one over. Displaying fewer than all of them is
 * a decision for whatever is doing the displaying, which knows how much room it has.
 */
const MAX_GROUPS = 12;

/** How many members, doors or neighbours to name before saying "and N more". */
const MAX_NAMED = 10;

/** A way in that this group is responsible for, and what stands in front of it. */
export interface GroupDoor {
  /** How the door reads to someone who does not have the code open: `POST /api/users`. */
  name: string;
  /** What checks the caller, named as written in the code. Empty means nothing was found. */
  guards: string[];
  /**
   * Why nothing was found, when nothing was — never absent just because `guards` is empty.
   *
   * This field is the difference between a true sentence and the worst sentence this tool
   * could write. On the FastAPI template every one of its 23 routes comes back with no
   * guard, and the reason is not that they are open: the guard is applied in a file the
   * analyzer could not read. `unreadable` says so, `page` means public by design,
   * `auth-mount` means a mount guards it and we could not pin the mount to the route, and
   * only `worth-a-look` means we looked and genuinely found nothing.
   *
   * Handing a model an empty `guards` with none of that attached is handing it the
   * premise for "these routes are unprotected", about routes that are protected.
   */
  openKind?: OpenKind;
  /** The verdict in the reader's own words, when there is one to give. */
  openBecause?: string;
}

/** One group handing off to another, with the number of imports folded into it. */
export interface GroupLink {
  /** The other group's id. */
  toId: string;
  /** Its folder path, so a prompt or a reader never has to resolve the id. */
  toPath: string;
  /** How many import or reference edges between the two groups this stands for. */
  weight: number;
}

/**
 * One cluster of the codebase, and everything true about it that a description could
 * reasonably be built from.
 */
export interface Group {
  /** The module node this group was cut at. */
  id: string;
  /** Repo-relative folder path. The empty string is the repo root. */
  path: string;
  /** The folder's own name, for prose that would rather not say a whole path. */
  name: string;
  /** Files assigned to this group — its own, plus any subfolder not cut separately. */
  fileCount: number;
  /** The role most of its files play. */
  zone: Zone;
  /** Other roles present, so a mixed folder does not read as a pure one. */
  otherZones: Zone[];
  /** File and subfolder names inside it, capped. */
  members: string[];
  /** Ways in whose code sits in this group, capped at {@link MAX_NAMED}. */
  doors: GroupDoor[];
  /** How many there were before the cap, so a truncated list is never read as a whole one. */
  doorCount: number;
  /**
   * Names this group exports for other code to import — **all of them, or none**.
   *
   * Kept apart from `doors` rather than counted among them. An exported function *is* a
   * door — it is how a library is used — but a library has hundreds of them, and folding
   * them in would bury the two HTTP routes that a stranger can actually reach under a
   * hundred function names. They are two different questions and they get two lists.
   *
   * The all-or-nothing rule is the reason this is not simply capped like everything else.
   * `requests` exports 111 names; the first ten alphabetically are `add_dict_to_cookiejar`
   * and `address_in_network`, and a sentence built from that sample would be about the
   * library's obscure corners while never mentioning `get`. Every other list here is
   * homogeneous enough that ten of fifty still reads true. This one is not, so past the
   * cap it hands over the count alone and lets the sentence say "111 names" — which is
   * both what we know and all we know.
   */
  publicApi: string[];
  /** How many names were exported in total, named above or not. */
  publicApiCount: number;
  /** Tables and buckets its files read or write. */
  stores: string[];
  /** Outside companies its files call. */
  services: string[];
  /** Groups it imports from, heaviest first. */
  dependsOn: GroupLink[];
  /** Groups that import from it, heaviest first. */
  usedBy: GroupLink[];
}

/** The whole clustering, plus what it could not account for. */
export interface GroupMap {
  groups: Group[];
  /**
   * Files that landed in no group at all — only ones with no path to place them by.
   *
   * Expected to be zero. It is carried anyway because a clustering that quietly drops a
   * tenth of the repo looks exactly like one that does not, and this is the number that
   * tells them apart.
   */
  ungroupedFiles: number;
}

/**
 * Where a file goes when no folder in the cut is above it.
 *
 * Two cases reach this, and both are real. A repo can keep load-bearing files at its top
 * level — the fixture's `middleware.ts` is the Clerk check that guards half the app — and
 * a flat repo can have no subfolders at all, which without this would cluster into
 * nothing and describe none of itself.
 */
const ROOT_GROUP = { id: 'module:.', path: '', name: 'the repo root' };

/**
 * Cut the codebase into groups and work out the shape of each one.
 *
 * Deterministic: the same atlas gives the same groups in the same order, every run. That
 * matters more than it sounds. The bake-off found that CodeBoarding's *membership* was
 * byte-identical across two cold runs while every label changed, and a reader who runs a
 * tool twice and gets a differently-shaped answer stops believing either one.
 */
export function buildGroups(nodes: Iterable<AtlasNode>, edges: Iterable<AtlasEdge>): GroupMap {
  const all = [...nodes];
  const modules = all.filter((node) => node.kind === 'module');
  const files = all.filter((node) => node.kind === 'file');

  const cut = cutFolderTree(modules);

  // Every file answers to exactly one group: the deepest cut folder above it, or the root
  // bucket when there is none. Matching on the path rather than walking parent ids keeps a
  // file whose folder was collapsed out of the module tree from falling through.
  const groupOfPath = new Map<string, string>();
  let ungroupedFiles = 0;
  let usedRoot = false;
  for (const file of files) {
    if (!file.path) {
      ungroupedFiles++;
      continue;
    }
    const owner = deepestOwner(file.path, cut);
    groupOfPath.set(file.path, owner ?? ROOT_GROUP.id);
    if (!owner) usedRoot = true;
  }

  const draft = new Map<string, Draft>();
  for (const [id, node] of cut) {
    draft.set(id, blankDraft(id, dirPathOf(node), node.name));
  }
  // The root bucket exists only when something landed in it, so a tidy repo does not get
  // an empty group named after its own top level.
  if (usedRoot) draft.set(ROOT_GROUP.id, blankDraft(ROOT_GROUP.id, ROOT_GROUP.path, ROOT_GROUP.name));

  for (const file of files) {
    const id = groupOfPath.get(file.path ?? '');
    const entry = id ? draft.get(id) : undefined;
    if (!entry) continue;
    entry.files.push(file);
    entry.zones.set(file.zone, (entry.zones.get(file.zone) ?? 0) + 1);
  }

  attachOwned(all, draft, groupOfPath);
  attachLinks(edges, draft, groupOfPath, byId(all));

  // An arrow has to name the group at the other end, so the paths are resolved from the
  // drafts rather than from the finished groups — which do not all exist yet.
  const pathOf = new Map<string, string>();
  for (const [id, entry] of draft) pathOf.set(id, entry.path);

  const groups = [...draft.values()]
    .filter((entry) => entry.files.length > 0)
    .map((entry) => finish(entry, pathOf))
    // Biggest first, then by path, so two groups of equal size never swap places between
    // runs on nothing more than map insertion order.
    .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));

  return { groups, ungroupedFiles };
}

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

/**
 * Choose which folders are groups.
 *
 * Starts at the top of the tree and repeatedly opens up the biggest folder that is both
 * too big to describe in one sentence and has subfolders to open into. A folder that is
 * opened keeps its place in the cut only if it holds files of its own — otherwise it is
 * just a container and its children stand in for it.
 *
 * Exported because the cut is the claim. A test that pins which folders came back is
 * testing the thing this file exists to get right, and it can do it without a model.
 */
export function cutFolderTree(modules: AtlasNode[]): Map<string, AtlasNode> {
  const byPath = new Map<string, AtlasNode>();
  for (const node of modules) byPath.set(dirPathOf(node), node);

  const childrenOf = new Map<string, AtlasNode[]>();
  for (const node of modules) {
    const parent = node.parentId ?? '';
    const list = childrenOf.get(parent);
    if (list) list.push(node);
    else childrenOf.set(parent, [node]);
  }

  // The roots are the modules with no module parent — usually the children of the app
  // node, but a repo whose module tree starts deeper is handled by the same rule.
  const moduleIds = new Set(modules.map((node) => node.id));
  const roots = modules.filter((node) => !node.parentId || !moduleIds.has(node.parentId));

  const cut = new Map<string, AtlasNode>();
  for (const node of roots) cut.set(node.id, node);

  // Folders that will not be opened again: either they have just been opened, or opening
  // them would blow the budget. Without this the loop would pick the same folder forever,
  // because a folder that keeps its place after being opened still reports the same size.
  const settled = new Set<string>();

  for (;;) {
    const candidate = [...cut.values()]
      .filter(
        (node) =>
          !settled.has(node.id) &&
          descendants(node) > SPLIT_ABOVE &&
          (childrenOf.get(node.id) ?? []).length > 0,
      )
      // Deterministic pick: biggest, and path breaks the tie.
      .sort((a, b) => descendants(b) - descendants(a) || dirPathOf(a).localeCompare(dirPathOf(b)))[0];
    if (!candidate) break;

    const kids = childrenOf.get(candidate.id) ?? [];
    const keepsPlace = ownFiles(candidate) > 0;
    const after = cut.size + kids.length - (keepsPlace ? 0 : 1);
    settled.add(candidate.id);
    // One folder too wide to open is not a reason to stop opening the others. A repo whose
    // biggest folder is a hundred test fixtures would otherwise leave its actual source in
    // a single undescribed lump, which is the shape this whole file exists to avoid.
    if (after > MAX_GROUPS) continue;

    if (!keepsPlace) cut.delete(candidate.id);
    for (const kid of kids) cut.set(kid.id, kid);
  }

  const result = new Map<string, AtlasNode>();
  for (const node of cut.values()) result.set(node.id, node);
  return result;
}

/**
 * The deepest cut folder containing this file.
 *
 * Longest matching prefix wins, so a file in `src/lib/stripe/` belongs to `src/lib/stripe`
 * when that was cut and to `src/lib` when it was not.
 */
function deepestOwner(filePath: string, cut: Map<string, AtlasNode>): string | null {
  let bestId: string | null = null;
  let bestLength = -1;
  for (const [id, node] of cut) {
    const dir = dirPathOf(node);
    const inside = dir === '' || filePath === dir || filePath.startsWith(`${dir}/`);
    if (!inside) continue;
    if (dir.length > bestLength) {
      bestLength = dir.length;
      bestId = id;
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

interface Draft {
  id: string;
  path: string;
  name: string;
  files: AtlasNode[];
  zones: Map<Zone, number>;
  doors: GroupDoor[];
  publicApi: string[];
  stores: Set<string>;
  services: Set<string>;
  dependsOn: Map<string, number>;
  usedBy: Map<string, number>;
}

function blankDraft(id: string, path: string, name: string): Draft {
  return {
    id,
    path,
    name,
    files: [],
    zones: new Map(),
    doors: [],
    publicApi: [],
    stores: new Set(),
    services: new Set(),
    dependsOn: new Map(),
    usedBy: new Map(),
  };
}

/** Hang every door, table and outside service on the group whose code reaches it. */
function attachOwned(all: AtlasNode[], draft: Map<string, Draft>, groupOfPath: Map<string, string>): void {
  const groupsFor = (sites: CodeSite[] | undefined): Draft[] => {
    const seen = new Set<string>();
    const out: Draft[] = [];
    for (const site of sites ?? []) {
      const id = groupOfPath.get(site.path);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const entry = draft.get(id);
      if (entry) out.push(entry);
    }
    return out;
  };

  for (const node of all) {
    if (node.kind === 'endpoint') {
      const meta = node.meta as unknown as EndpointMeta;
      // The env "door" is a list of variables, not a way in. It is a real node for the
      // security screen and pure noise in a description of what a folder does.
      if (meta.endpointKind === 'env') continue;
      if (meta.endpointKind === 'export') {
        // Its name is the symbol; its route is the file it lives in, which the group
        // already accounts for.
        for (const entry of groupsFor(meta.sites)) entry.publicApi.push(node.name);
        continue;
      }
      // Reading a file off disk is a way data gets in, but it is not somewhere a caller
      // arrives, and the same exclusion is already made for the personal-data trace.
      if (meta.endpointKind === 'file-read') continue;
      const door: GroupDoor = {
        name: meta.route ? `${meta.method ?? meta.endpointKind} ${meta.route}` : node.name,
        guards: (meta.guards ?? []).map((guard) => guard.name),
        ...(meta.open ? { openKind: meta.open.kind } : {}),
        ...(meta.open?.because ? { openBecause: meta.open.because } : {}),
      };
      for (const entry of groupsFor(meta.sites)) entry.doors.push(door);
    } else if (node.kind === 'service') {
      const meta = node.meta as unknown as ServiceMeta;
      for (const entry of groupsFor(meta.sites)) entry.services.add(node.name);
    } else if (node.kind === 'store') {
      const meta = node.meta as unknown as StoreMeta;
      for (const entry of groupsFor(meta.sites)) entry.stores.add(node.name);
    }
  }
}

/**
 * Fold every file-to-file edge up into an edge between groups.
 *
 * Edges inside a group are dropped: that a folder imports itself is not a fact about the
 * folder. What survives is the handoff, which is the thing a paragraph about architecture
 * is actually made of.
 */
function attachLinks(
  edges: Iterable<AtlasEdge>,
  draft: Map<string, Draft>,
  groupOfPath: Map<string, string>,
  nodesById: Map<string, AtlasNode>,
): void {
  for (const edge of edges) {
    if (edge.kind !== 'imports' && edge.kind !== 'references') continue;
    const from = nodesById.get(edge.fromId);
    const to = nodesById.get(edge.toId);
    if (!from || !to || from.kind !== 'file' || to.kind !== 'file') continue;

    const fromGroup = groupOfPath.get(from.path ?? '');
    const toGroup = groupOfPath.get(to.path ?? '');
    if (!fromGroup || !toGroup || fromGroup === toGroup) continue;

    const source = draft.get(fromGroup);
    const target = draft.get(toGroup);
    if (!source || !target) continue;

    source.dependsOn.set(toGroup, (source.dependsOn.get(toGroup) ?? 0) + edge.weight);
    target.usedBy.set(fromGroup, (target.usedBy.get(fromGroup) ?? 0) + edge.weight);
  }
}

function finish(entry: Draft, pathOf: Map<string, string>): Group {
  const zones = [...entry.zones.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const exported = [...new Set(entry.publicApi)].sort((a, b) => a.localeCompare(b));

  // Doors can arrive more than once when a route's sites straddle two files in the same
  // folder. The reader wants the route listed once.
  const doors: GroupDoor[] = [];
  const seenDoors = new Set<string>();
  for (const door of entry.doors) {
    if (seenDoors.has(door.name)) continue;
    seenDoors.add(door.name);
    doors.push(door);
  }

  return {
    id: entry.id,
    path: entry.path,
    name: entry.name,
    fileCount: entry.files.length,
    zone: zones[0]?.[0] ?? 'unknown',
    otherZones: zones.slice(1).map(([zone]) => zone),
    members: entry.files
      .map((file) => baseName(file.path ?? file.name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_NAMED),
    doors: doors.slice(0, MAX_NAMED),
    doorCount: doors.length,
    publicApi: exported.length > MAX_NAMED ? [] : exported,
    publicApiCount: exported.length,
    stores: [...entry.stores].sort((a, b) => a.localeCompare(b)),
    services: [...entry.services].sort((a, b) => a.localeCompare(b)),
    dependsOn: toLinks(entry.dependsOn, pathOf),
    usedBy: toLinks(entry.usedBy, pathOf),
  };
}

function toLinks(counts: Map<string, number>, pathOf: Map<string, string>): GroupLink[] {
  return [...counts.entries()]
    .map(([toId, weight]) => ({ toId, toPath: pathOf.get(toId) ?? toId, weight }))
    .sort((a, b) => b.weight - a.weight || a.toPath.localeCompare(b.toPath))
    .slice(0, MAX_NAMED);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function byId(nodes: AtlasNode[]): Map<string, AtlasNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function dirPathOf(node: AtlasNode): string {
  const meta = node.meta as unknown as ModuleMeta;
  return String(meta.dirPath ?? node.path ?? '');
}

function descendants(node: AtlasNode): number {
  const meta = node.meta as unknown as ModuleMeta;
  return Number(meta.descendantFileCount ?? meta.fileCount ?? 0);
}

function ownFiles(node: AtlasNode): number {
  const meta = node.meta as unknown as ModuleMeta;
  return Number(meta.fileCount ?? 0);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}
