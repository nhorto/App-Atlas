import { makeModuleId } from '../model/types.js';
import { hashParts } from '../util/hash.js';
import { ancestorDirs, baseNameOf, dirOfPosix } from '../util/paths.js';
export function buildModuleTree(files, appId) {
    const filesByDir = new Map();
    const childDirs = new Map();
    const ensureDir = (dir) => {
        if (!childDirs.has(dir))
            childDirs.set(dir, new Set());
        if (!filesByDir.has(dir))
            filesByDir.set(dir, []);
    };
    ensureDir('');
    for (const file of files) {
        const dir = dirOfPosix(file.relPath);
        ensureDir(dir);
        filesByDir.get(dir).push(file);
        for (const ancestor of ancestorDirs(file.relPath)) {
            ensureDir(ancestor);
            const parent = dirOfPosix(ancestor);
            ensureDir(parent);
            childDirs.get(parent).add(ancestor);
        }
    }
    const modules = [];
    const parentForFile = new Map();
    const zonesByModule = new Map();
    // Files sitting directly in the repo root belong to the app itself.
    for (const file of filesByDir.get('') ?? []) {
        parentForFile.set(file.relPath, appId);
    }
    const emit = (startDir, parentId) => {
        // Walk down through pass-through directories, remembering the chain we collapsed.
        const chain = [startDir];
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
        for (const file of ownFiles)
            parentForFile.set(file.relPath, id);
        const zones = ownFiles.map((f) => f.zone);
        let descendantFileCount = ownFiles.length;
        const node = {
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
//# sourceMappingURL=modules.js.map