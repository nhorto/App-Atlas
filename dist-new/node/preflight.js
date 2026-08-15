/**
 * @fileoverview The two rules that must run before anything else loads.
 *
 * Kept apart from `cli.ts` so they can be tested as functions rather than only through
 * a spawned process, and deliberately importing **nothing** — not even from this
 * codebase. That is the whole constraint: `cli.ts` may import this file statically and
 * still be guaranteed to run before `node:sqlite` is touched, because there is nothing
 * here that could reach it.
 */
/** The floor, and why. `package.json` engines says the same thing. */
export const MINIMUM_NODE = { major: 22, minor: 5 };
/**
 * Whether this Node is below the floor.
 *
 * Compared as numbers, per component. The obvious string compare gets `'24' < '22.5'`
 * wrong — a bug that would turn every future Node into an unsupported one, quietly,
 * for everybody.
 */
export function nodeIsTooOld(version) {
    const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
    if (major !== MINIMUM_NODE.major)
        return major < MINIMUM_NODE.major;
    return minor < MINIMUM_NODE.minor;
}
/**
 * What somebody on an old Node is told instead of a stack trace.
 *
 * `engines` is not enforced by `npx` or `npm install` — they warn at most, and the
 * warning scrolls past — so on Node 20 the first contact anybody had with this tool
 * was `SyntaxError: The requested module 'node:sqlite' does not provide an export
 * named 'DatabaseSync'`. Nobody reads that as "my Node is old"; they read it as "this
 * is broken" (#112). Naming the version they have is what makes the difference.
 */
export function tooOldMessage(version) {
    return (`\n  App Atlas needs Node ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer — you have ${version}.\n` +
        `  It keeps the map in the SQLite that ships inside Node, which is what makes\n` +
        `  installing it free of anything that has to compile.\n\n` +
        `  Install a newer Node from https://nodejs.org, or with nvm:\n` +
        `    nvm install 22 && nvm use 22\n\n`);
}
/**
 * Whether a warning is Node's notice that its own SQLite is experimental (#114).
 *
 * Matched by type *and* text, so a deprecation, an unhandled rejection, or an
 * experimental warning about anything else still reaches the reader. `--no-warnings`
 * would have been one flag and would have hidden all of those with it.
 */
export function isSqliteExperimentalWarning(warning, type) {
    const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
    const name = typeof type === 'string' ? type : (type?.type ?? '');
    return name === 'ExperimentalWarning' && /\bSQLite\b/.test(text);
}
/** Installs the filter above on the current process, and returns what it replaced. */
export function silenceSqliteWarning() {
    const emitWarning = process.emitWarning.bind(process);
    process.emitWarning = ((warning, ...rest) => {
        if (isSqliteExperimentalWarning(warning, rest[0]))
            return;
        return emitWarning(warning, ...rest);
    });
}
//# sourceMappingURL=preflight.js.map