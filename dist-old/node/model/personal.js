/**
 * Phrases that mean one thing in a column name. Matched against the whole column first,
 * longest phrase before shortest, so `date_of_birth` never arrives as a bare `date`.
 */
const DIRECT_PHRASES = [
    [/^(e[_-]?mail|email)(_?address(es)?)?$/, 'contact', 'email'],
    [/^(emails)$/, 'contact', 'email'],
    [/^(ssn|social_security(_number)?)$/, 'government-id', 'ssn'],
    [/^(national_id(_number)?|nino|tax_id(_number)?|tin)$/, 'government-id', 'national id'],
    [/^passport(_(number|no|num))?$/, 'government-id', 'passport'],
    [/^driver'?s?_licen[cs]e(_number)?$/, 'government-id', "driver's licence"],
    [/^(dob|date_of_birth|birth_?date|birthday)$/, 'date-of-birth', 'date of birth'],
    [/^(first|last|given|family|middle)_names?$/, 'person-name', 'personal name'],
    [/^(surname|forename|maiden_name)$/, 'person-name', 'personal name'],
    [/^(phone|mobile|telephone|cell)(_?(number|no))?$/, 'contact', 'phone number'],
    [/^(credit_card|card)_(number|no|num)$/, 'financial', 'card number'],
    [/^(cvv|cvc|card_security_code)$/, 'financial', 'card security code'],
    [/^(iban|bic|swift_?code|sort_code|routing_number)$/, 'financial', 'bank identifier'],
    [/^(bank_account(_number)?)$/, 'financial', 'bank account'],
    [/^(password|passwd|pwd|password_hash|hashed_password|password_digest)$/, 'credential', 'password'],
    [/^(mfa_secret|totp_secret|two_factor_secret|recovery_codes?)$/, 'credential', 'second factor'],
    [/^(ip|ip_address|ip_addr|remote_addr|client_ip)$/, 'device', 'IP address'],
    [/^(mac_address|imei|device_id|advertising_id|idfa)$/, 'device', 'device identifier'],
    [/^(street_address|postal_address|home_address|billing_address|shipping_address)$/, 'location', 'postal address'],
    [/^(diagnosis|medical_record(_number)?|blood_type|nhs_number)$/, 'health', 'health record'],
];
/**
 * Names that point at personal data often enough to be worth a reader's glance and not
 * often enough to be worth an assertion.
 */
const AMBIGUOUS_PHRASES = [
    [/^(name|full_name|display_name|user_?name|nick_?name|screen_?name)$/, 'person-name', 'name'],
    [/^(address|addr)$/, 'location', 'address'],
    [/^(city|town|postcode|postal_code|zip|zip_code|county|country|region)$/, 'location', 'place'],
    [/^(lat|latitude|lng|lon|longitude|geo|coordinates)$/, 'location', 'coordinates'],
    [/^(account_number|customer_(id|number|reference))$/, 'financial', 'account reference'],
    [/^(licen[cs]e_number|id_number)$/, 'government-id', 'identifier'],
    [/^(age|gender|sex|ethnicity|nationality|marital_status)$/, 'person-name', 'personal detail'],
    [/^(user_agent|fingerprint)$/, 'device', 'device fingerprint'],
    [/^(contact|contact_details|emergency_contact)$/, 'contact', 'contact details'],
];
/**
 * Qualifiers that make an otherwise-personal word technical. `file_name` and `host_name`
 * are not people, and on a repo of any size they outnumber the real matches badly enough
 * to bury them.
 *
 * Written as words rather than whole column names so it generalizes: nobody has to add
 * `template_name` for the rule to know that a template is not a person.
 */
const NOT_A_PERSON = new Set([
    'file', 'table', 'column', 'field', 'class', 'schema', 'index', 'tag', 'brand', 'product',
    'event', 'type', 'role', 'method', 'package', 'service', 'bucket', 'queue', 'topic', 'job',
    'step', 'node', 'key', 'image', 'icon', 'theme', 'locale', 'currency', 'host', 'domain',
    'app', 'repo', 'branch', 'project', 'org', 'organization', 'organisation', 'team', 'company',
    'store', 'variant', 'category', 'folder', 'directory', 'template', 'plan', 'tier', 'status',
    'model', 'variable', 'env', 'server', 'cluster', 'container', 'volume', 'network', 'route',
    'action', 'command', 'script', 'module', 'function', 'group', 'label', 'channel', 'topic',
    'workspace', 'tenant', 'site', 'page', 'menu', 'item', 'sku', 'currency', 'unit', 'metric',
    'wallet', 'contract', 'token', 'chain', 'block', 'bus', 'memory', 'device', 'display',
]);
/**
 * What kind of personal data a column name points at, or `null` when nothing matched.
 *
 * Exported because it is the whole of the judgement in this module, and a caller that
 * wants to check one name — a test, or a future data-flow pass — should not have to build
 * a graph to do it.
 */
export function classifyColumn(rawName) {
    const name = normalize(rawName);
    if (!name)
        return null;
    const parts = name.split('_');
    // `ip_address` is a direct device match and `address` alone is an ambiguous location
    // one, so the qualifier is checked before the bare word, not after.
    const qualifier = parts.length > 1 ? parts[0] : null;
    for (const [pattern, category, matched] of DIRECT_PHRASES) {
        if (pattern.test(name))
            return { column: rawName, category, strength: 'direct', matched };
    }
    // A technical qualifier settles it: `file_name` is a filename, and no amount of `name`
    // at the end of it makes the row a person.
    if (qualifier && NOT_A_PERSON.has(qualifier))
        return null;
    for (const [pattern, category, matched] of AMBIGUOUS_PHRASES) {
        if (pattern.test(name))
            return { column: rawName, category, strength: 'ambiguous', matched };
    }
    // Compound names the app made up — `customer_email`, `applicant_dob` — are the normal
    // case in a real schema, so the last token gets the same treatment on its own.
    if (parts.length > 1) {
        const tail = parts.slice(1).join('_');
        const inner = tail === name ? null : classifyColumn(tail);
        // Only a direct tail survives. Promoting an ambiguous tail would turn every
        // `foo_name` in the repo into a person, which is the failure this guards against.
        if (inner && inner.strength === 'direct')
            return { ...inner, column: rawName };
    }
    return null;
}
/**
 * Whether a field points at another shape rather than holding a value.
 *
 * documenso's `EmailDomain` has a field called `emails`, and it is not a column of email
 * addresses — it is `OrganisationEmail[]`, a list of related rows. Classifying it as
 * personal data is simply wrong, and the name gives no hint of that; only the type does.
 *
 * Decided by asking whether the type names something else in the graph, so it holds for a
 * Prisma relation, a SQLAlchemy `Mapped[list[...]]` and a foreign-key column alike,
 * without a list of per-ORM scalar type names to keep up to date.
 */
export function looksLikeRelation(fieldType, knownTypeNames) {
    const bare = fieldType.replace(/[[\]?!\s]/g, '').replace(/^(Array|List|list|Optional|Mapped)</, '').replace(/>$/, '');
    return bare.length > 0 && knownTypeNames.has(bare.toLowerCase());
}
/**
 * Turns `firstName`, `first-name` and `FIRST_NAME` into the one spelling the patterns are
 * written against, so a schema's house style never decides whether a column is seen.
 */
function normalize(raw) {
    return raw
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase();
}
/**
 * Every table whose column names suggest it holds personal data, with the doors that
 * reach it.
 *
 * Ordered by how much a reader should care: tables with direct matches first, then by how
 * many columns matched, so the row that opens the section is the one worth opening.
 */
export function findPersonalData(nodes, edges) {
    const tables = [];
    const byId = new Map();
    const typeNames = new Set();
    for (const node of nodes) {
        byId.set(node.id, node);
        if (node.kind !== 'type')
            continue;
        typeNames.add(node.name.toLowerCase());
        if (node.meta.typeKind === 'table')
            tables.push(node);
    }
    if (tables.length === 0)
        return { tables: [], ambiguousOnly: [], unknownColumns: [], tablesConsidered: 0 };
    const doorsBySite = doorsByHandler(edges, byId);
    const sitesByTable = new Map();
    for (const edge of edges) {
        if (edge.kind !== 'references')
            continue;
        const list = sitesByTable.get(edge.toId);
        if (list)
            list.push(edge.fromId);
        else
            sitesByTable.set(edge.toId, [edge.fromId]);
    }
    const found = [];
    const unknownColumns = [];
    const ambiguousOnly = [];
    /** Table node id → the model that declared its columns, when one did. */
    const sameTable = new Map();
    for (const table of tables) {
        const meta = table.meta;
        const fields = meta.fields ?? [];
        if (fields.length === 0) {
            // Named in a query, declared nowhere. Silence here would read as "nothing personal
            // in it", and the honest answer is that its columns were never visible at all.
            unknownColumns.push({ id: table.id, name: table.name });
            continue;
        }
        const columns = [];
        for (const field of fields) {
            if (looksLikeRelation(field.type, typeNames))
                continue;
            const hit = classifyColumn(field.name);
            if (hit)
                columns.push(hit);
        }
        if (columns.length === 0)
            continue;
        const declaredBy = table.meta.declaredBy;
        if (declaredBy)
            sameTable.set(table.id, declaredBy);
        // A row has to be earned by a name that means one thing. An `Organisation` table with
        // a `name` column is not a personal-data finding, and a list that says it is stops
        // being read — which costs more than the row was ever worth.
        if (!columns.some((column) => column.strength === 'direct')) {
            ambiguousOnly.push({ id: table.id, name: table.name });
            continue;
        }
        found.push({
            id: table.id,
            name: table.name,
            alsoKnownAs: [],
            path: table.path,
            columns,
            doors: reachingDoors(sitesByTable.get(table.id) ?? [], doorsBySite),
        });
    }
    found.sort((a, b) => {
        const directs = countDirect(b) - countDirect(a);
        if (directs !== 0)
            return directs;
        return b.columns.length - a.columns.length || a.name.localeCompare(b.name);
    });
    // After the sort, so the row that survives a collapse is the best-evidenced one.
    collapseSameTable(found, sameTable);
    return {
        tables: found,
        // The same fold, for the same reason: this is a *count* a reader will repeat, and
        // `CookBook` and `cookbooks` are one table.
        ambiguousOnly: dedupeByModel(ambiguousOnly, sameTable),
        unknownColumns,
        tablesConsidered: tables.length,
    };
}
/**
 * Fold the rows that are one table wearing two names into a single row.
 *
 * Two table nodes joined to the same model class are the same table by construction —
 * that is what the join established. Keeping both would double every count taken off this
 * list. The surviving row keeps the other names so nothing a reader might search for is
 * lost, and the doors are unioned because each name was reached from different code.
 *
 * Rows without a declaring model are left exactly as they are: two SQL tables that happen
 * to share nothing but a schema are not the same table, and there is no evidence here to
 * say otherwise.
 */
function collapseSameTable(tables, declaredBy) {
    const first = new Map();
    for (let i = tables.length - 1; i >= 0; i--) {
        const table = tables[i];
        const model = declaredBy.get(table.id);
        if (!model)
            continue;
        const held = first.get(model);
        if (!held) {
            first.set(model, table);
            continue;
        }
        // Keep the earlier row — it is the better-evidenced one under the sort that follows —
        // and move this row's name and doors onto it.
        if (!held.alsoKnownAs.includes(table.name))
            held.alsoKnownAs.push(table.name);
        for (const door of table.doors) {
            if (!held.doors.some((known) => known.id === door.id))
                held.doors.push(door);
        }
        held.doors.sort((a, b) => a.name.localeCompare(b.name));
        tables.splice(i, 1);
    }
    for (const table of tables)
        table.alsoKnownAs.sort();
}
/** The same collapse for a plain name list: one entry per table, whatever it is called. */
function dedupeByModel(entries, declaredBy) {
    const seen = new Set();
    return entries.filter((entry) => {
        const model = declaredBy.get(entry.id);
        if (!model)
            return true;
        if (seen.has(model))
            return false;
        seen.add(model);
        return true;
    });
}
function countDirect(table) {
    return table.columns.filter((column) => column.strength === 'direct').length;
}
/**
 * Which doors expose which handler, in the direction this module needs to walk.
 *
 * `exposed-by` runs door → handler, so it is inverted once here rather than scanned again
 * for every table.
 */
function doorsByHandler(edges, byId) {
    const map = new Map();
    for (const edge of edges) {
        if (edge.kind !== 'exposed-by')
            continue;
        const door = byId.get(edge.fromId);
        if (!door || !isWayIn(door))
            continue;
        const entry = { id: door.id, name: doorLabel(door) };
        const list = map.get(edge.toId);
        if (list)
            list.push(entry);
        else
            map.set(edge.toId, [entry]);
    }
    return map;
}
/**
 * Whether a door is something outside the app can actually knock on.
 *
 * An exported function is a way in for the project's own code, not for the world, and on
 * documenso's schema package every table came back "reached by" six seed scripts —
 * `seedUser`, `unseedUserByEmail` — which is true, useless, and crowds out the real
 * answer. The question this list answers is who can reach the data from outside, so the
 * weakest kind of door is left out of it and the honest result on a package with no
 * routes is no doors at all.
 */
function isWayIn(door) {
    const kind = door.meta.endpointKind;
    return kind !== 'export' && kind !== 'file-read';
}
/** The route if it has one, else the handler's own name — whichever a reader can find. */
function doorLabel(door) {
    const meta = door.meta;
    if (!meta.route)
        return door.name;
    return meta.method ? `${meta.method} ${meta.route}` : meta.route;
}
/** The doors behind a table's query sites, deduplicated and in a stable order. */
function reachingDoors(sites, doorsBySite) {
    const seen = new Map();
    for (const site of sites) {
        for (const door of doorsBySite.get(site) ?? [])
            seen.set(door.id, door);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=personal.js.map