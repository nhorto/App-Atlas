import { DEFAULTS } from '../dialect.js';
/**
 * Generated C#, by the conventions the ecosystem actually uses.
 *
 * `obj/` alone is most of it: every .NET build writes `AssemblyInfo.cs`,
 * `.AssemblyAttributes.cs` and a `.NETCoreApp,Version=…` shim in there on every build,
 * and a repo analyzed after a `dotnet build` would otherwise report a dozen files nobody
 * wrote. The `.g.cs`/`.designer.cs` pairs are the same idea one layer up — Razor,
 * WinForms and resource designers all stamp them.
 */
const GENERATED = [
    /(^|\/)(obj|bin)\//i,
    /\.g\.cs$/i,
    /\.g\.i\.cs$/i,
    /\.designer\.cs$/i,
    /\.generated\.cs$/i,
    /(^|\/)GlobalUsings\.g\.cs$/i,
    /(^|\/)AssemblyInfo\.cs$/i,
    /\.AssemblyAttributes\.cs$/i,
    /\.feature\.cs$/i,
];
/** Declarations whose visibility is worth reading, and which carry `modifier` children. */
const DECLARATIONS = new Set([
    'class_declaration',
    'interface_declaration',
    'record_declaration',
    'record_struct_declaration',
    'struct_declaration',
    'enum_declaration',
    'delegate_declaration',
    'method_declaration',
    'constructor_declaration',
    'property_declaration',
    'field_declaration',
    'event_field_declaration',
    'local_function_statement',
]);
/**
 * Modifiers that make a member visible outside the assembly it was compiled into.
 *
 * `protected` counts: a subclass in somebody else's project can see it, which is the
 * question this flag exists to answer. `internal` does not — it is visible across the
 * assembly and no further, which is exactly the line "exported" draws.
 */
const PUBLIC_MODIFIERS = new Set(['public', 'protected']);
/** Whether a declaration node is visible outside its assembly, by the words on it. */
function isPublicDeclaration(node) {
    let sawModifier = false;
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type !== 'modifier')
            continue;
        sawModifier = true;
        if (PUBLIC_MODIFIERS.has(child.text))
            return true;
    }
    // No access modifier at all. An interface's members are public by definition — that is
    // what an interface is — and everything else in C# defaults to the most private thing
    // its context allows, which is never visible outside the assembly.
    if (sawModifier)
        return false;
    return node.parent?.parent?.type === 'interface_declaration';
}
/** Every declaration in the file, by the character it starts at. */
function declarationsByStart(root) {
    const out = new Map();
    const walk = (node) => {
        if (DECLARATIONS.has(node.type))
            out.set(node.startIndex, node);
        for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child)
                walk(child);
        }
    };
    walk(root);
    return out;
}
/**
 * The name each member declaration declares, so a field read off the tree can be matched
 * to the field the query already recorded. Properties name themselves; a field statement
 * can declare several at once (`private int a, b;`) and every one of them shares the
 * statement's modifiers.
 */
function declaredNames(node) {
    if (node.type === 'property_declaration' || node.type === 'event_field_declaration') {
        const name = node.childForFieldName('name');
        return name ? [name.text] : [];
    }
    const out = [];
    const walk = (current) => {
        if (current.type === 'variable_declarator') {
            const name = current.childForFieldName('name');
            if (name)
                out.push(name.text);
            return;
        }
        for (let i = 0; i < current.namedChildCount; i++) {
            const child = current.namedChild(i);
            if (child)
                walk(child);
        }
    };
    walk(node);
    return out;
}
/**
 * The names a type declaration says it extends or implements, type arguments stripped.
 *
 * `class Sync : BackgroundService, IDisposable` lists both; `Repository<Order>` is
 * `Repository` to anything matching names against a list. The base list is the last
 * place C# writes a fact this tier needs and the capture vocabulary cannot name — the
 * same situation as visibility, solved the same way.
 */
function baseNames(node) {
    const bases = node.namedChildren.find((child) => child?.type === 'base_list');
    if (!bases)
        return [];
    const out = [];
    for (let i = 0; i < bases.namedChildCount; i++) {
        const child = bases.namedChild(i);
        if (!child)
            continue;
        const text = child.text.trim();
        if (!text)
            continue;
        const bare = text.replace(/<[\s\S]*$/, '');
        const last = bare.split('.').pop();
        if (last)
            out.push(last);
    }
    return out;
}
export const csharpDialect = {
    ...DEFAULTS,
    id: 'csharp',
    displayName: 'C#',
    extensions: ['.cs'],
    skip: GENERATED,
    // A namespace, not a folder. `Glance.App.Dashboard` may be spread over three
    // directories and a directory may hold two namespaces; the file says which it is in.
    scope: 'namespace',
    /**
     * Never called for anything that matters — `finish` replaces every answer below with
     * the keyword the file actually wrote. It stays honest rather than optimistic for the
     * window in which it is the only answer there is: a name alone cannot tell you whether
     * somebody typed `public`, and claiming otherwise is the thing this tier must not do.
     */
    exported: () => false,
    /** `Microsoft.AspNetCore.Mvc` → `Mvc`. C# separates with dots, not slashes. */
    localName(module) {
        const parts = module.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? module;
    },
    strings: new Set(['string_literal', 'verbatim_string_literal', 'raw_string_literal', 'interpolated_string_expression']),
    numbers: new Set(['integer_literal', 'real_literal']),
    names: new Set(['identifier', 'qualified_name', 'member_access_expression', 'generic_name']),
    identifiers: new Set(['identifier']),
    qualified: new Set(['qualified_name', 'member_access_expression']),
    functions: new Set(['lambda_expression', 'anonymous_method_expression']),
    calls: new Set(['invocation_expression', 'object_creation_expression', 'implicit_object_creation_expression']),
    /**
     * C# has four ways to write a string and they do not nest the same way.
     *
     *   "plain"        one layer of quotes
     *   @"verbatim"    an at-sign, then quotes, and `""` inside means one quote
     *   """raw"""      three or more quotes, and nothing inside is escaped
     *   $"{x} is here" an interpolation, whose *fixed* part is the only part we can know
     *
     * A route written `@"api/v1"` and one written `"api/v1"` are the same address, and a
     * reader who is shown `@"api/v1"` on the map has been handed the source rather than
     * the answer.
     */
    unquote(text) {
        let body = text.trim();
        const interpolated = body.startsWith('$');
        if (interpolated)
            body = body.slice(1);
        if (body.startsWith('@')) {
            body = body.slice(1);
            if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
                return body.slice(1, -1).replace(/""/g, '"');
            }
            return body;
        }
        const raw = /^("{3,})([\s\S]*)\1$/.exec(body);
        if (raw)
            return raw[2].replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
        if (body.startsWith('"') && body.endsWith('"') && body.length >= 2)
            return body.slice(1, -1);
        return body;
    },
    /**
     * Strips the comment markers, and then the XML.
     *
     * C# documents itself in markup — `/// <summary>Renders the chart.</summary>` — and
     * the tags are furniture, not words. Left in, the first thing a reader sees on a card
     * is `<summary>`, which is the source rather than the answer, and the same sentence
     * reaches `ATLAS.md` and every prompt built from it.
     *
     * `<c>` and `<see cref="X"/>` name a thing and are unwrapped to that name; everything
     * else is dropped and its content kept. A stray `<` in prose is left alone, because a
     * doc comment that says "if x < y" is not markup and should not lose half its sentence.
     */
    uncomment(text) {
        const withoutMarkers = text
            .replace(/^\s*\/\/\/?/, '')
            .replace(/^\s*\/\*+/, '')
            .replace(/\*+\/\s*$/, '')
            .replace(/^\s*\*\s?/, '');
        return withoutMarkers
            // `<see cref="Foo.Bar"/>` and `<paramref name="x"/>` mean the name they carry.
            .replace(/<(?:see|seealso)\b[^>]*?(?:cref|href)\s*=\s*"([^"]*)"[^>]*\/?>/gi, (_, ref) => String(ref).replace(/^[A-Z]:/, ''))
            .replace(/<(?:paramref|typeparamref)\b[^>]*?name\s*=\s*"([^"]*)"[^>]*\/?>/gi, '$1')
            // Every other doc tag is structure. Drop the tag, keep what it wrapped.
            .replace(/<\/?(?:summary|remarks|para|c|code|b|i|list|item|term|description|value|returns|example|exception|typeparam|param|inheritdoc|br)\b[^>]*>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    },
    /**
     * Reads the visibility keyword off every declaration and corrects what the query
     * recorded.
     *
     * Matched by character offset, which is the one thing the query captures and the tree
     * agree on exactly. Fields are matched by name within their owning type, because a
     * field statement can declare three names at once and the shared IR keeps a field as a
     * name and a type rather than as a range.
     */
    finish(file, root) {
        // A C# file has no header comment, because C# has no such convention: the `///`
        // block goes on the *type*, and the file is named after it. One public type per file
        // is how the language is written and how every .NET style guide says to write it, so
        // for a file that declares exactly one type, that type's description is the file's.
        //
        // Without this a 209-file desktop app with 151 documented files reported **0%**
        // documented, and offered to teach the agent to write the docs it had already
        // written.
        if (!file.doc) {
            const types = file.defs.filter((def) => def.kind === 'type');
            if (types.length === 1 && types[0]?.doc)
                file.doc = types[0].doc;
        }
        const declarations = declarationsByStart(root);
        for (const def of file.defs) {
            const node = declarations.get(def.startIndex);
            if (node)
                def.exported = isPublicDeclaration(node);
            // `class Sync : BackgroundService` — the base list is the declaration a detector
            // needs to see, and the capture vocabulary has no name for it, so it is read off
            // the tree here the way visibility is. `partial` is the same situation again: the
            // keyword is the entire evidence that two files declare one class (#97).
            if (node && def.kind === 'type') {
                def.bases = baseNames(node);
                for (let i = 0; i < node.namedChildCount; i++) {
                    const child = node.namedChild(i);
                    if (child?.type === 'modifier' && child.text === 'partial')
                        def.partial = true;
                }
            }
        }
        // A member's modifiers belong to the declaration that wrote it, so walk the members
        // and hand each name its own answer.
        const visibility = new Map();
        for (const node of declarations.values()) {
            if (node.type !== 'property_declaration' && node.type !== 'field_declaration' && node.type !== 'event_field_declaration') {
                continue;
            }
            const isPublic = isPublicDeclaration(node);
            for (const name of declaredNames(node))
                visibility.set(`${node.startIndex}:${name}`, isPublic);
        }
        for (const def of file.defs) {
            for (const field of def.fields) {
                for (const [key, isPublic] of visibility) {
                    const at = Number(key.slice(0, key.indexOf(':')));
                    if (key.slice(key.indexOf(':') + 1) !== field.name)
                        continue;
                    if (at < def.startIndex || at > def.endIndex)
                        continue;
                    field.exported = isPublic;
                    break;
                }
            }
        }
        // A positional record's parameters *are* its public shape — `record OrderRequest(
        // string Sku, int Quantity)` compiles to public properties — and they never pass
        // through a declaration with a modifier on it.
        for (const def of file.defs) {
            const node = declarations.get(def.startIndex);
            if (node?.type !== 'record_declaration' && node?.type !== 'record_struct_declaration')
                continue;
            const positional = new Set((node.childForFieldName('parameters') ?? node.namedChildren.find((child) => child?.type === 'parameter_list'))
                ?.namedChildren.map((child) => child?.childForFieldName('name')?.text)
                .filter((name) => Boolean(name)) ?? []);
            for (const field of def.fields)
                if (positional.has(field.name))
                    field.exported = true;
        }
    },
};
//# sourceMappingURL=dialect.js.map