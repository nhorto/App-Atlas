/**
 * @fileoverview Module tree construction.
 *
 * Turns a flat list of file paths into the nested containment structure the map
 * drills through. Two rules keep the levels readable:
 *
 * 1. Every directory that (eventually) holds source files becomes a module node.
 * 2. Pass-through directories collapse. `src/app/(dashboard)/settings` with nothing
 *    but one child at each step renders as a single node, not four empty ones.
 */
import type { AtlasNode, Zone } from '../model/types.js';
import { makeModuleId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import { ancestorDirs, baseNameOf, dirOfPosix } from '../util/paths.js';

export interface ModuleInput {
  relPath: string;
  zone: Zone;
}

export interface ModuleTree {
  modules: AtlasNode[];
  /** relPath of a file → id of the node that should contain it. */
  parentForFile: Map<string, string>;
}

export function buildModuleTree(files: ModuleInput[], appId: string): ModuleTree {
  const filesByDir = new Map<string, ModuleInput[]>();
  const childDirs = new Map<string, Set<string>>();

  const ensureDir = (dir: string) => {
    if (!childDirs.has(dir)) childDirs.set(dir, new Set());
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
  };

  ensureDir('');
  for (const file of files) {
    const dir = dirOfPosix(file.relPath);
    ensureDir(dir);
    filesByDir.get(dir)!.push(file);
    for (const ancestor of ancestorDirs(file.relPath)) {
      ensureDir(ancestor);
      const parent = dirOfPosix(ancestor);
      ensureDir(parent);
      childDirs.get(parent)!.add(ancestor);
    }
  }

  const modules: AtlasNode[] = [];
  const parentForFile = new Map<string, string>();
  const zonesByModule = new Map<string, Zone[]>();

  // Files sitting directly in the repo root belong to the app itself.
  for (const file of filesByDir.get('') ?? []) {
    parentForFile.set(file.relPath, appId);
  }

  const emit = (startDir: string, parentId: string): { fileCount: number; zones: Zone[] } => {
    // Walk down through pass-through directories, remembering the chain we collapsed.
    const chain: string[] = [startDir];
    let dir = startDir;
    for (;;) {
      const kids = [...(childDirs.get(dir) ?? [])];
      const ownFiles = filesByDir.get(dir) ?? [];
      if (ownFiles.length === 0 && kids.length === 1) {
        dir = kids[0];
        chain.push(dir);
        continue;
      }
      break;
    }

    const id = makeModuleId(dir);
    const displayName = chain.map(baseNameOf).join('/');
    const ownFiles = filesByDir.get(dir) ?? [];
    for (const file of ownFiles) parentForFile.set(file.relPath, id);

    const zones: Zone[] = ownFiles.map((f) => f.zone);
    let descendantFileCount = ownFiles.length;

    const node: AtlasNode = {
      id,
      kind: 'module',
      name: displayName,
      label: null,
      parentId,
      language: null,
      path: dir,
      startLine: null,
      endLine: null,
      zone: 'unknown',
      summary: null,
      summarySource: null,
      docHash: null,
      bodyHash: null,
      hash: hashParts('module', dir),
      provenance: 'static',
      meta: {
        dirPath: dir,
        fileCount: ownFiles.length,
        descendantFileCount: 0,
        collapsedFrom: chain.length > 1 ? chain : undefined,
      },
    };
    modules.push(node);

    for (const child of [...(childDirs.get(dir) ?? [])].sort((a, b) => a.localeCompare(b))) {
      const result = emit(child, id);
      descendantFileCount += result.fileCount;
      zones.push(...result.zones);
    }

    node.meta.descendantFileCount = descendantFileCount;
    zonesByModule.set(id, zones);
    return { fileCount: descendantFileCount, zones };
  };

  for (const topDir of [...(childDirs.get('') ?? [])].sort((a, b) => a.localeCompare(b))) {
    emit(topDir, appId);
  }

  return { modules, parentForFile };
}
