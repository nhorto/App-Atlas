/**
 * @fileoverview What Go says about itself that its grammar does not.
 *
 * The whole per-language cost of reading a new language, once the query file exists.
 * If this ever grows past a screenful, something has been written here that belonged in
 * `queries/go.scm`.
 */
import { DEFAULTS } from '../dialect.js';
/**
 * Generated Go, by the conventions the ecosystem actually uses: protobuf, mocks, and
 * anything a code generator stamped with `zz_` so it would sort last.
 *
 * Left out rather than read because a `.pb.go` is forty thousand lines of machine output
 * that nobody wrote, nobody reads, and whose functions would swamp every count on the
 * screen. `vendor/` is already excluded for every language.
 */
const GENERATED = [/\.pb\.go$/, /\.pb\.gw\.go$/, /_generated\.go$/, /\.gen\.go$/, /(^|\/)zz_generated[^/]*\.go$/, /(^|\/)mock_[^/]*\.go$/];
export const goDialect = {
    ...DEFAULTS,
    id: 'go',
    displayName: 'Go',
    extensions: ['.go'],
    skip: GENERATED,
    // Go's entire visibility rule. No keyword, no modifier: the case of the first letter
    // decides whether another package can see the name, and that is the whole of it.
    exported: (name) => /^[A-Z]/.test(name),
    /**
     * `github.com/go-chi/chi/v5` is typed `chi`, not `v5`.
     *
     * Go puts the major version in the import path and leaves it out of the package name —
     * semantic import versioning, and every library past v1 uses it. Taking the last
     * segment gives you a package called `v5`, after which `chi.NewRouter()` matches
     * nothing and a chi service reports no routes at all. `gopkg.in/yaml.v3` writes the
     * same idea with a dot.
     *
     * Only ever a default. Go lets a package be named anything its source says, and when
     * the two differ the file writes the alias out — which the caller has already used.
     */
    localName(module) {
        const parts = module.split('/').filter(Boolean);
        const last = parts[parts.length - 1] ?? module;
        if (/^v\d+$/.test(last) && parts.length > 1)
            return parts[parts.length - 2];
        return last.replace(/\.v\d+$/, '');
    },
    strings: new Set(['interpreted_string_literal', 'raw_string_literal']),
    numbers: new Set(['int_literal', 'float_literal', 'imaginary_literal', 'rune_literal']),
    names: new Set([
        'identifier',
        'field_identifier',
        'type_identifier',
        'package_identifier',
        'selector_expression',
        'qualified_type',
    ]),
    identifiers: new Set(['identifier', 'type_identifier', 'field_identifier']),
    qualified: new Set(['selector_expression', 'qualified_type']),
    functions: new Set(['func_literal']),
};
//# sourceMappingURL=dialect.js.map