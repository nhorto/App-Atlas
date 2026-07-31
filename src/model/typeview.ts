/**
 * @fileoverview The type explorer — dbdiagram for your code (SPEC.md 6.3).
 *
 * Types are the tables of application code: a name, a list of fields, and lines to the
 * other shapes those fields point at. The atlas already holds all of that, so the work
 * here is the same reduction the boundary view does — choosing which shapes are worth
 * a card, and turning "this type mentions that one" into "this *row* points there".
 *
 * Two kinds of line come out of this, and the difference is deliberately visible:
 *
 *   declared  the code or the schema says so — a field's type, a Prisma relation
 *   name      a table and a type share a name, and nothing more than that
 *
 * The second is a guess. It is genuinely useful — `User` in the schema and `User` in
 * the code usually are the same idea — but it is not a fact, so it never draws the
 * same line as one, and it never enters the atlas itself.
 */
import type { AtlasNode, FieldInfo, SummarySource, TypeMeta, Zone } from './types.js';
import type { AtlasGraph } from './graph.js';
import { classifyColumn, looksLikeRelation, type PersonalColumn } from './personal.js';

export type TypeKind = TypeMeta['typeKind'];

export interface TypeField {
  name: string;
  type: string;
  optional: boolean;
  isId?: boolean;
  isUnique?: boolean;
  /** The card this row points at, when that card is on screen. */
  linkTo: string | null;
  /**
   * Set when this column's *name* suggests it holds personal data (issue #48). Tables
   * only, and a name match only — no value was ever read.
   *
   * Marked on the row rather than as a badge on the card on purpose: the evidence is one
   * column, and a table-level "holds personal data" label is a verdict this cannot
   * support. A reader who sees the mark on `email` and not on `id` can tell instantly
   * what was and was not matched, which a card-level badge hides.
   */
  personal?: PersonalColumn;
}

export interface TypeCard {
  id: string;
  name: string;
  typeKind: TypeKind;
  path: string | null;
  startLine: number | null;
  zone: Zone;
  fields: TypeField[];
  /** Fields past the ones listed — a card stays readable, the panel has them all. */
  hiddenFields: number;
  summary: string | null;
  summarySource: SummarySource;
  /** Places that refer to this shape, weighted by how often. */
  usage: number;
  usageByZone: { zone: Zone; count: number }[];
  /** Unions and other aliases have no fields but still have a shape. */
  aliasOf: string | null;
  /** Tables only: which database engine. */
  provider: string | null;
}

export interface TypeLink {
  id: string;
  fromId: string;
  toId: string;
  /** The rows that made the link. Empty when the reference was not a field. */
  fields: string[];
  basis: 'declared' | 'name';
}

export interface TypeView {
  cards: TypeCard[];
  links: TypeLink[];
  /** Every type in the atlas, including the ones that did not earn a card. */
  total: number;
  tables: number;
}

const MAX_CARDS = 60;
const MAX_FIELDS = 12;

export function buildTypeView(graph: AtlasGraph, limit = MAX_CARDS): TypeView {
  const all = graph.nodesOfKind('type');
  const usage = new Map<string, { total: number; byZone: Map<Zone, number> }>();

  for (const node of all) {
    const byZone = new Map<Zone, number>();
    let total = 0;
    for (const edge of graph.edgesTo(node.id)) {
      if (edge.kind !== 'references') continue;
      const from = graph.getNodeById(edge.fromId);
      if (!from || from.id === node.id) continue;
      total += edge.weight;
      byZone.set(from.zone, (byZone.get(from.zone) ?? 0) + edge.weight);
    }
    usage.set(node.id, { total, byZone });
  }

  const chosen = chooseCards(all, usage, limit);
  const onScreen = new Set(chosen.map((node) => node.id));
  const links = buildLinks(graph, chosen, onScreen);
  // Built from every type in the atlas, not just the ones that earned a card: a relation
  // pointing at a shape too minor to draw is still a relation and still not a column.
  const typeNames = new Set(all.map((node) => node.name.toLowerCase()));

  const outgoingByCard = new Map<string, TypeLink[]>();
  for (const link of links) {
    const list = outgoingByCard.get(link.fromId);
    if (list) list.push(link);
    else outgoingByCard.set(link.fromId, [link]);
  }

  const cards = chosen.map((node) => toCard(node, usage.get(node.id), outgoingByCard.get(node.id) ?? [], typeNames));

  return {
    cards,
    links,
    total: all.length,
    tables: cards.filter((card) => card.typeKind === 'table').length,
  };
}

/**
 * Which shapes earn a card. Tables first — a database table is the most concrete thing
 * in an app and the reason anyone opens this view — then whatever the rest of the code
 * actually leans on. An unexported type nobody references is real, but it is not what
 * someone came here to look at.
 */
function chooseCards(
  all: AtlasNode[],
  usage: Map<string, { total: number; byZone: Map<Zone, number> }>,
  limit: number,
): AtlasNode[] {
  const score = (node: AtlasNode): number => {
    const meta = node.meta as unknown as TypeMeta;
    let value = usage.get(node.id)?.total ?? 0;
    if (meta.typeKind === 'table') value += 1000;
    if (meta.isExported) value += 12;
    if (meta.fields.length > 0) value += 4;
    if (node.zone === 'test') value -= 40;
    return value;
  };

  return [...all]
    .filter((node) => {
      const meta = node.meta as unknown as TypeMeta;
      if (meta.typeKind === 'table') return true;
      // A private type nobody mentions is noise on a canvas this size.
      return meta.isExported || (usage.get(node.id)?.total ?? 0) > 0;
    })
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function buildLinks(graph: AtlasGraph, chosen: AtlasNode[], onScreen: Set<string>): TypeLink[] {
  const links: TypeLink[] = [];
  const seen = new Set<string>();

  for (const node of chosen) {
    for (const edge of graph.edgesFrom(node.id)) {
      if (edge.kind !== 'references' || !onScreen.has(edge.toId) || edge.toId === node.id) continue;
      const id = `${node.id}->${edge.toId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      links.push({
        id,
        fromId: node.id,
        toId: edge.toId,
        fields: [...((edge.meta.fields as string[] | undefined) ?? [])],
        basis: 'declared',
      });
    }
  }

  // A table and a type that share a name are usually the same idea wearing two hats.
  // Saying so is useful; pretending the compiler said so is not, hence a separate basis.
  const codeByName = new Map<string, AtlasNode>();
  for (const node of chosen) {
    if ((node.meta as unknown as TypeMeta).typeKind === 'table') continue;
    const key = node.name.toLowerCase();
    if (!codeByName.has(key)) codeByName.set(key, node);
  }

  for (const node of chosen) {
    if ((node.meta as unknown as TypeMeta).typeKind !== 'table') continue;
    const twin = codeByName.get(node.name.toLowerCase());
    if (!twin) continue;
    const id = `${twin.id}~${node.id}`;
    if (seen.has(id) || seen.has(`${twin.id}->${node.id}`) || seen.has(`${node.id}->${twin.id}`)) continue;
    seen.add(id);
    links.push({ id, fromId: twin.id, toId: node.id, fields: [], basis: 'name' });
  }

  return links;
}

function toCard(
  node: AtlasNode,
  usage: { total: number; byZone: Map<Zone, number> } | undefined,
  outgoing: TypeLink[],
  typeNames: Set<string>,
): TypeCard {
  const meta = node.meta as unknown as TypeMeta;
  const all = meta.fields ?? [];
  const shown = all.slice(0, MAX_FIELDS);

  return {
    id: node.id,
    name: node.name,
    typeKind: meta.typeKind,
    path: node.path,
    startLine: node.startLine,
    zone: node.zone,
    // Restricted to tables. A code type with an `email` field is telling the same story,
    // but marking every shape in the project turns the mark into wallpaper — and the
    // question this answers is about where data is *kept*.
    fields: shown.map((field) => toField(field, outgoing, meta.typeKind === 'table', typeNames)),
    hiddenFields: all.length - shown.length,
    summary: node.summary,
    summarySource: node.summarySource,
    usage: usage?.total ?? 0,
    usageByZone: [...(usage?.byZone ?? new Map<Zone, number>())]
      .map(([zone, count]) => ({ zone, count }))
      .sort((a, b) => b.count - a.count),
    aliasOf: typeof node.meta.aliasOf === 'string' ? node.meta.aliasOf : null,
    provider: meta.provider ?? null,
  };
}

function toField(field: FieldInfo, outgoing: TypeLink[], isTable: boolean, typeNames: Set<string>): TypeField {
  const link = outgoing.find((candidate) => candidate.fields.includes(field.name));
  const personal = isTable && !looksLikeRelation(field.type, typeNames) ? classifyColumn(field.name) : null;
  return {
    name: field.name,
    type: field.type,
    optional: field.optional,
    isId: field.isId,
    isUnique: field.isUnique,
    linkTo: link?.toId ?? null,
    ...(personal ? { personal } : {}),
  };
}
