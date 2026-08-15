/**
 * @fileoverview Where the MCP server gets its facts: a previous analysis, read off disk.
 *
 * The server never analyses. That is a decision, not an omission (SPEC.md section 13):
 * an MCP client starts its servers at the beginning of a session and expects them to
 * answer in milliseconds, analysis on a large repo takes tens of seconds, it writes into
 * the user's project, and on a metered AI backend it would want to ask about money to a
 * stdin that belongs to a protocol. A tool that cannot answer says so in a sentence
 * naming the command that would fix it, which an agent can act on and a person can read.
 *
 * What it does do is notice when the analysis on disk has been replaced. Somebody running
 * `app-atlas analyze --watch` in another terminal while their agent works is the loop
 * this whole feature exists for, so the atlas is re-read whenever its file has moved on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AtlasGraph } from '../model/graph.js';
import { atlasDbPath, atlasJsonPath, loadAtlas, readScopes } from '../model/store.js';
/**
 * The atlases under one project root, loaded on demand and kept until they change.
 *
 * A monorepo keeps one atlas per app (SPEC.md 5.6), so "which app are we talking about"
 * is a real question here. Answering the first one silently would be the usual thing to
 * do and the wrong one — every result names the app it is about, and says what else was
 * there to ask.
 */
export class AtlasSource {
    root;
    cache = new Map();
    constructor(root) {
        this.root = root;
    }
    /** Every app in this project: the workspace's, or the root itself when there is no workspace. */
    apps() {
        const scopes = readScopes(this.root);
        if (scopes.length === 0) {
            return [{ id: '', name: path.basename(this.root) || this.root, dir: this.root }];
        }
        return scopes.map((scope) => ({
            id: scope.id,
            name: scope.name,
            dir: path.join(this.root, scope.dir),
        }));
    }
    /**
     * The atlas to answer a call from, or the sentence to send back instead.
     *
     * `scope` is the app's id or name in a monorepo. Left out, the first app answers —
     * and the caller is told which one that was rather than being allowed to assume.
     */
    resolve(scope) {
        const apps = this.apps();
        const wanted = typeof scope === 'string' ? scope.trim() : '';
        let app = apps[0];
        if (wanted) {
            const match = apps.find((candidate) => candidate.id === wanted || candidate.name === wanted);
            if (!match) {
                const known = apps.map((candidate) => candidate.id || candidate.name).join(', ') || 'none';
                return { found: false, because: `No app called "${wanted}" here. This project has: ${known}.` };
            }
            app = match;
        }
        if (!app) {
            return { found: false, because: `Nothing to read in ${this.root}.` };
        }
        const graph = this.graphFor(app.dir);
        if (!graph) {
            return {
                found: false,
                because: `No atlas in ${app.dir}. This server reads an analysis that has already been run; ` +
                    `it never runs one itself. Run \`app-atlas analyze ${app.dir}\` in a terminal, then call this tool again.`,
            };
        }
        return { found: true, graph, app };
    }
    /** Reads the atlas for one directory, reusing the last read while the file is unchanged. */
    graphFor(dir) {
        const stamp = stampOf(dir);
        if (!stamp) {
            this.cache.delete(dir);
            return null;
        }
        const cached = this.cache.get(dir);
        if (cached && cached.stamp === stamp)
            return cached.graph;
        const atlas = loadAtlas(dir);
        if (!atlas) {
            this.cache.delete(dir);
            return null;
        }
        const graph = new AtlasGraph(atlas);
        this.cache.set(dir, { stamp, graph });
        return graph;
    }
}
/**
 * A short string that changes whenever this project's atlas does, and is empty when
 * there is not one.
 *
 * Both files are considered because `loadAtlas` falls back to the JSON export when the
 * database is missing, and a stamp that ignored the file actually being read would serve
 * a stale answer forever. Size rides along with the timestamp because two writes can
 * land inside the same millisecond, and re-reading a file needlessly is cheaper than
 * answering an agent about code it has already changed.
 */
function stampOf(dir) {
    const parts = [];
    for (const file of [atlasDbPath(dir), atlasJsonPath(dir)]) {
        try {
            const stat = fs.statSync(file);
            parts.push(`${stat.mtimeMs}:${stat.size}`);
        }
        catch {
            /* a missing file is one of the two normal answers */
        }
    }
    return parts.join('|');
}
//# sourceMappingURL=atlas.js.map