/**
 * @fileoverview The one question every surface must answer the same way: did we read
 * enough of this repository to be believed?
 *
 * huginn is a Rails application — 469 `.rb` files, dozens of controllers, MySQL, a
 * scheduler — and App Atlas reads no Ruby, which is a legitimate limit. The map it
 * produced was not: "18 files, 1 way in, 0 data stores", every count true and the
 * whole presented in the same confident type used everywhere, with the archetype
 * shrugging "a collection of code" (#171). A reader who does not already know the
 * repo's language believes that map.
 *
 * The product's own principle already covers this at file scale — an unreadable file
 * hedges the auth headline rather than being silently skipped (#132) — and a whole
 * unreadable language is the same fact at a thousand times the weight. This module is
 * where the threshold and the wording live, so the CLI summary, the archetype and the
 * auth headline cannot drift into three different opinions about the same blindness.
 */

/** What to call an extension when telling somebody we could not read it. */
const LANGUAGE_NAMES: Record<string, string> = {
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.scala': 'Scala',
  '.groovy': 'Groovy',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.swift': 'Swift',
  '.m': 'Objective-C',
  '.mm': 'Objective-C',
  '.dart': 'Dart',
  '.clj': 'Clojure',
  '.cljs': 'Clojure',
  '.hs': 'Haskell',
  '.lua': 'Lua',
  '.pl': 'Perl',
  '.pm': 'Perl',
  '.jl': 'Julia',
  '.zig': 'Zig',
  '.nim': 'Nim',
  '.cr': 'Crystal',
  '.fs': 'F#',
  '.vb': 'Visual Basic',
};

export function languageName(ext: string): string {
  return LANGUAGE_NAMES[ext] ?? ext;
}

export interface UnreadBackbone {
  /** Distinct language names, largest first. */
  languages: string[];
  /** Files in all of them together. */
  total: number;
}

/**
 * The languages this repository is *mostly* written in when they are ones App Atlas
 * cannot read — or null when the map covers enough to stand on its own.
 *
 * The threshold is dominance: more unread source files than read ones. Below that, a
 * Rails engine vendored into a TS app or one build script in Ruby should not hedge a
 * map that genuinely covers the application — a hedge that fires when nothing is
 * uncertain teaches a reader to skip hedges (#116, from the other side). At huginn's
 * 469-to-18 any threshold fires; dominance is the one that keeps quiet everywhere else.
 */
export function unreadBackbone(
  unreadLanguages: { ext: string; count: number }[] | undefined,
  readFiles: number,
): UnreadBackbone | null {
  if (!unreadLanguages || unreadLanguages.length === 0) return null;
  const total = unreadLanguages.reduce((sum, entry) => sum + entry.count, 0);
  if (total <= readFiles) return null;

  const byLanguage = new Map<string, number>();
  for (const entry of unreadLanguages) {
    const name = languageName(entry.ext);
    byLanguage.set(name, (byLanguage.get(name) ?? 0) + entry.count);
  }
  const languages = [...byLanguage.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return { languages, total };
}

/**
 * "469 Ruby files" / "512 Java and Kotlin files" — the noun phrase every surface shares.
 *
 * Grouped, the way every other count in prose here is (`unimported.ts`, `tours.ts`,
 * `markdown.ts`). It never mattered while the biggest number this phrase had ever printed
 * was huginn's 469; discourse's is `10848`, which a reader has to stop and count digits
 * on, in the one sentence written to be read before anything else (#273).
 */
export function backbonePhrase(backbone: UnreadBackbone): string {
  const named = backbone.languages.slice(0, 2).join(' and ');
  return `${backbone.total.toLocaleString('en-US')} ${named} ${backbone.total === 1 ? 'file' : 'files'}`;
}
