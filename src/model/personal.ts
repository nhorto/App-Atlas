/**
 * @fileoverview Column names that look like personal data, and the doors that reach them
 * (issue #48).
 *
 * The atlas already knows every table and every column on it. What it has never said is
 * what *kind* of data those columns hold — which is the half of the boundary question a
 * customer actually asks out loud, usually as "so where does our customer data live".
 *
 * **This reads names. It never reads values.** Nothing here opens a database, and nothing
 * here infers from data. A column called `email` is evidence about what somebody intended
 * to store, and that is all it is. Two failures follow from that, and both are stated in
 * the product rather than hidden:
 *
 *   - **It over-fires.** `address` is a wallet address on a crypto app and a server
 *     address on an infrastructure one. Names like that are reported as ambiguous and
 *     never counted alongside the direct ones.
 *   - **It under-fires, and worse.** A column called `user_reference`, `field_7` or
 *     `payload` can hold a passport number, and no name-matcher will ever know. So a
 *     table absent from this list has not been cleared — it has only failed to match a
 *     name. The exporter says exactly that, because the alternative is a reader deciding
 *     an empty section means their app holds no personal data.
 *
 * This is deliberately the *first rung* of the data-flow question and not a compliance
 * answer. It names what was seen and cites where, in the same register as the auth
 * badges, and it never rounds an ambiguous match up to a direct one.
 */
import type { AtlasEdge, AtlasNode, TypeMeta } from './types.js';

/**
 * What a matched column appears to hold. Kept coarse on purpose — the useful distinction
 * for somebody being asked a question in a meeting is "which of these is a government
 * identifier and which is a postcode", not a taxonomy with forty leaves.
 */
export type PersonalCategory =
  | 'contact'
  | 'person-name'
  | 'government-id'
  | 'financial'
  | 'location'
  | 'date-of-birth'
  | 'credential'
  | 'device'
  | 'health';

/**
 * How much the name alone is worth.
 *
 * `direct` — in a database column this word means one thing: `ssn`, `email`, `iban`.
 * `ambiguous` — it commonly means personal data and commonly does not: `name`, `address`,
 * `city`. Reported, because a reader who knows the app can settle it in a second, and
 * kept apart from `direct` in every count, because rounding it up is the whole failure
 * this issue was filed to avoid.
 */
export type MatchStrength = 'direct' | 'ambiguous';

export interface PersonalColumn {
  /** The column exactly as the schema spells it, so it can be searched for. */
  column: string;
  category: PersonalCategory;
  strength: MatchStrength;
  /** The word that matched, which is the entire reason this row is here. */
  matched: string;
}

/** A door that reaches the code that queries a table. */
export interface ReachingDoor {
  id: string;
  /** The route or handler name, as the boundary view already labels it. */
  name: string;
}

export interface PersonalTable {
  id: string;
  /** The table as the schema names it. */
  name: string;
  /**
   * The same table's other names, when the queries reached it under more than one.
   *
   * A SQLAlchemy app names its table twice: `select(User)` records the class name, and a
   * migration or raw query records `users`. Both arrive as table nodes, both are joined
   * to the same model, and both hold identical columns. Listing them as two rows would
   * say an app holds personal data in two tables when it holds it in one — an inflation
   * of exactly the number somebody is about to repeat in a meeting.
   */
  alsoKnownAs: string[];
  path: string | null;
  columns: PersonalColumn[];
  /**
   * Doors whose own handler queries this table, found by following the query sites the
   * analyzer already recorded.
   *
   * One hop, deliberately. A door that reaches the table through a helper two files down
   * is not listed, so this under-counts on any app with a repository layer. Empty means
   * none was traced — never that none exists, and never that the table is unreachable.
   */
  doors: ReachingDoor[];
}

export interface PersonalDataReport {
  /** Tables with at least one *direct* match, best-evidenced first. */
  tables: PersonalTable[];
  /**
   * Tables where the only matches were ambiguous — almost always a lone `name` column.
   *
   * Held back from the list rather than dropped. Measured on documenso, listing them put
   * `ApiToken`, `BackgroundJob` and `Folder` in a personal-data section on the strength of
   * having a column called `name`, which is eleven rows of noise around fourteen real
   * ones. Counted here so the number is still stated, because "we found nothing on these"
   * and "we did not look at these" are different facts.
   */
  ambiguousOnly: { id: string; name: string }[];
  /**
   * Tables the code queries by name with no schema declaring their columns. They cannot
   * be classified either way, and counting them as clean would be the single most
   * misleading thing this module could do.
   */
  unknownColumns: { id: string; name: string }[];
  /** How many tables were looked at at all — the denominator for everything above. */
  tablesConsidered: number;
}

/**
 * Phrases that mean one thing in a column name. Matched against the whole column first,
 * longest phrase before shortest, so `date_of_birth` never arrives as a bare `date`.
 */
const DIRECT_PHRASES: [RegExp, PersonalCategory, string][] = [
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
const AMBIGUOUS_PHRASES: [RegExp, PersonalCategory, string][] = [
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
export function classifyColumn(rawName: string): PersonalColumn | null {
  const name = normalize(rawName);
  if (!name) return null;

  const parts = name.split('_');
  // `ip_address` is a direct device match and `address` alone is an ambiguous location
  // one, so the qualifier is checked before the bare word, not after.
  const qualifier = parts.length > 1 ? parts[0] : null;

  for (const [pattern, category, matched] of DIRECT_PHRASES) {
    if (pattern.test(name)) return { column: rawName, category, strength: 'direct', matched };
  }

  // A technical qualifier settles it: `file_name` is a filename, and no amount of `name`
  // at the end of it makes the row a person.
  if (qualifier && NOT_A_PERSON.has(qualifier)) return null;

  for (const [pattern, category, matched] of AMBIGUOUS_PHRASES) {
    if (pattern.test(name)) return { column: rawName, category, strength: 'ambiguous', matched };
  }

  // Compound names the app made up — `customer_email`, `applicant_dob` — are the normal
  // case in a real schema, so the last token gets the same treatment on its own.
  if (parts.length > 1) {
    const tail = parts.slice(1).join('_');
    const inner = tail === name ? null : classifyColumn(tail);
    // Only a direct tail survives. Promoting an ambiguous tail would turn every
    // `foo_name` in the repo into a person, which is the failure this guards against.
    if (inner && inner.strength === 'direct') return { ...inner, column: rawName };
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
export function looksLikeRelation(fieldType: string, knownTypeNames: Set<string>): boolean {
  const bare = fieldType.replace(/[[\]?!\s]/g, '').replace(/^(Array|List|list|Optional|Mapped)</, '').replace(/>$/, '');
  return bare.length > 0 && knownTypeNames.has(bare.toLowerCase());
}

/**
 * Turns `firstName`, `first-name` and `FIRST_NAME` into the one spelling the patterns are
 * written against, so a schema's house style never decides whether a column is seen.
 */
function normalize(raw: string): string {
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
export function findPersonalData(nodes: Iterable<AtlasNode>, edges: Iterable<AtlasEdge>): PersonalDataReport {
  const tables: AtlasNode[] = [];
  const byId = new Map<string, AtlasNode>();
  const typeNames = new Set<string>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (node.kind !== 'type') continue;
    typeNames.add(node.name.toLowerCase());
    if ((node.meta as unknown as TypeMeta).typeKind === 'table') tables.push(node);
  }
  if (tables.length === 0) return { tables: [], ambiguousOnly: [], unknownColumns: [], tablesConsidered: 0 };

  const doorsBySite = doorsByHandler(edges, byId);
  const sitesByTable = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'references') continue;
    const list = sitesByTable.get(edge.toId);
    if (list) list.push(edge.fromId);
    else sitesByTable.set(edge.toId, [edge.fromId]);
  }

  const found: PersonalTable[] = [];
  const unknownColumns: { id: string; name: string }[] = [];
  const ambiguousOnly: { id: string; name: string }[] = [];
  /** Table node id → the model that declared its columns, when one did. */
  const sameTable = new Map<string, string>();

  for (const table of tables) {
    const meta = table.meta as unknown as TypeMeta;
    const fields = meta.fields ?? [];
    if (fields.length === 0) {
      // Named in a query, declared nowhere. Silence here would read as "nothing personal
      // in it", and the honest answer is that its columns were never visible at all.
      unknownColumns.push({ id: table.id, name: table.name });
      continue;
    }

    const columns: PersonalColumn[] = [];
    for (const field of fields) {
      if (looksLikeRelation(field.type, typeNames)) continue;
      const hit = classifyColumn(field.name);
      if (hit) columns.push(hit);
    }
    if (columns.length === 0) continue;

    const declaredBy = (table.meta as { declaredBy?: string }).declaredBy;
    if (declaredBy) sameTable.set(table.id, declaredBy);

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
    if (directs !== 0) return directs;
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
function collapseSameTable(tables: PersonalTable[], declaredBy: Map<string, string>): void {
  const first = new Map<string, PersonalTable>();
  for (let i = tables.length - 1; i >= 0; i--) {
    const table = tables[i];
    const model = declaredBy.get(table.id);
    if (!model) continue;
    const held = first.get(model);
    if (!held) {
      first.set(model, table);
      continue;
    }
    // Keep the earlier row — it is the better-evidenced one under the sort that follows —
    // and move this row's name and doors onto it.
    if (!held.alsoKnownAs.includes(table.name)) held.alsoKnownAs.push(table.name);
    for (const door of table.doors) {
      if (!held.doors.some((known) => known.id === door.id)) held.doors.push(door);
    }
    held.doors.sort((a, b) => a.name.localeCompare(b.name));
    tables.splice(i, 1);
  }
  for (const table of tables) table.alsoKnownAs.sort();
}

/** The same collapse for a plain name list: one entry per table, whatever it is called. */
function dedupeByModel(
  entries: { id: string; name: string }[],
  declaredBy: Map<string, string>,
): { id: string; name: string }[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const model = declaredBy.get(entry.id);
    if (!model) return true;
    if (seen.has(model)) return false;
    seen.add(model);
    return true;
  });
}

function countDirect(table: PersonalTable): number {
  return table.columns.filter((column) => column.strength === 'direct').length;
}

/**
 * Which doors expose which handler, in the direction this module needs to walk.
 *
 * `exposed-by` runs door → handler, so it is inverted once here rather than scanned again
 * for every table.
 */
function doorsByHandler(edges: Iterable<AtlasEdge>, byId: Map<string, AtlasNode>): Map<string, ReachingDoor[]> {
  const map = new Map<string, ReachingDoor[]>();
  for (const edge of edges) {
    if (edge.kind !== 'exposed-by') continue;
    const door = byId.get(edge.fromId);
    if (!door || !isWayIn(door)) continue;
    const entry = { id: door.id, name: doorLabel(door) };
    const list = map.get(edge.toId);
    if (list) list.push(entry);
    else map.set(edge.toId, [entry]);
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
function isWayIn(door: AtlasNode): boolean {
  const kind = (door.meta as { endpointKind?: string }).endpointKind;
  return kind !== 'export' && kind !== 'file-read';
}

/** The route if it has one, else the handler's own name — whichever a reader can find. */
function doorLabel(door: AtlasNode): string {
  const meta = door.meta as { route?: string; method?: string };
  if (!meta.route) return door.name;
  return meta.method ? `${meta.method} ${meta.route}` : meta.route;
}

/** The doors behind a table's query sites, deduplicated and in a stable order. */
function reachingDoors(sites: string[], doorsBySite: Map<string, ReachingDoor[]>): ReachingDoor[] {
  const seen = new Map<string, ReachingDoor>();
  for (const site of sites) {
    for (const door of doorsBySite.get(site) ?? []) seen.set(door.id, door);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
