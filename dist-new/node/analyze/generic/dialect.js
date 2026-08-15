/** The parts most grammars spell the same way. Spread into a dialect and override. */
export const DEFAULTS = {
    strings: new Set(['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal']),
    numbers: new Set(['int_literal', 'float_literal', 'integer', 'float', 'number']),
    names: new Set(['identifier', 'field_identifier', 'type_identifier', 'selector_expression', 'attribute']),
    identifiers: new Set(['identifier', 'type_identifier', 'field_identifier']),
    qualified: new Set(['selector_expression', 'qualified_type', 'attribute']),
    functions: new Set(['func_literal', 'function_literal', 'lambda', 'closure', 'arrow_function']),
    calls: new Set(['call_expression', 'call', 'invocation_expression', 'method_invocation']),
    comment: 'comment',
    /** Drops one layer of quotes or backticks, and nothing else. */
    unquote(text) {
        const first = text[0];
        if (!first)
            return text;
        if ((first === '"' || first === "'" || first === '`') && text.endsWith(first) && text.length >= 2) {
            return text.slice(1, -1);
        }
        return text;
    },
    /** The last path segment. Right for most languages, and the starting point for Go. */
    localName(module) {
        const parts = module.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? module;
    },
    /** Strips a line's comment markers — slashes, hashes, or a block comment's fences. */
    uncomment(text) {
        return text
            .replace(/^\/\*+/, '')
            .replace(/\*+\/$/, '')
            .replace(/^\s*(\/\/+|#+|\*)\s?/, '')
            .trim();
    },
};
//# sourceMappingURL=dialect.js.map