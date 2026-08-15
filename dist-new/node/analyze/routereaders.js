/**
 * @fileoverview Frameworks this tool can name but whose routes it never reads.
 *
 * There are three ways a repository ends up with zero doors, and only one of them is
 * news. It can genuinely answer no URL. It can be written in a language nothing here
 * parses — which `unreadBackbone` already catches, and which every surface already
 * hedges for. Or it can be a language we parse fine, using a framework we detect and
 * name at the top of the map, for which no route reader was ever written.
 *
 * The third case had nothing to express it. Rust files parse, so the unparseable-
 * extension caveat never fired, and vaultwarden — 305 Rocket routes across 60 files —
 * was handed "nothing answers a URL" beside a framework list reading `["Diesel",
 * "Rocket"]`. The contradiction was internal and checkable, which is what made it
 * worth a rule rather than an apology (#257).
 *
 * Every fact the honest sentence needs was already present: the framework table says
 * which crates are web frameworks, the manifest says which are declared, and the
 * detector gate says no reader ran. This module is only the seam that joins them.
 *
 * It is deliberately a list of frameworks rather than a computed thing. Whether a
 * reader exists for a framework is a fact about this codebase that a person knows and
 * a program cannot infer — the day someone writes the Rocket reader, they delete the
 * entry, and the test that fails if they forget is the one that counts its routes.
 */
import { RUST_ROUTES_NOT_READ } from './generic/rust/frameworks.js';
/**
 * Every framework here whose routes go unread, in the order the project lists them.
 *
 * Takes the labels rather than the raw dependency names because that is what survives
 * onto `meta.frameworks` — the same strings the reader sees on the map, so a caveat
 * naming Rocket names it exactly as the headline above it does.
 */
export function frameworksWithoutRouteReader(frameworks) {
    return frameworks.filter((name) => RUST_ROUTES_NOT_READ.has(name));
}
//# sourceMappingURL=routereaders.js.map