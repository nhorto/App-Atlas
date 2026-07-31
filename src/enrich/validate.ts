/**
 * @fileoverview The gate between a model's reply and the atlas.
 *
 * Nothing generated is trusted on the way in. A reply can be wrapped in a markdown
 * fence, prefixed with "Sure! Here's the JSON:", contain keys we never asked about,
 * or be an error message that a shell dutifully printed to stdout. Every one of those
 * has to bounce off this file, because the alternative is a wrong sentence displayed
 * next to a compiler-derived fact with nothing to tell them apart.
 *
 * A reply can also arrive in perfect shape and still say something we can prove wrong.
 * The bottom half of this file is that check: prose is held to the endpoint table, and a
 * sentence that pairs one of your routes with a verb it does not answer to is dropped
 * rather than repaired.
 *
 * The bias is always the same: drop it. A missing description is a small
 * disappointment; a confident wrong one costs the reader their trust in the map.
 */

/**
 * Pulls an object out of a reply. Models are asked for bare JSON and mostly comply;
 * this handles the times they wrap it in a fence or introduce it politely.
 */
export function parseJsonReply(text: string): Record<string, unknown> | null {
  const withoutFence = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Phrases that mean the backend failed rather than answered. An agent CLI that is
 * signed out still exits zero and prints its complaint to stdout, so without this
 * check "Not logged in · Please run /login" becomes the description of forty files.
 * Matched only at the start, so a genuine sentence about an error path survives.
 */
const FAILURE_OPENERS = [
  /^(i'?m sorry|i am sorry|i cannot|i can'?t|sorry,)/i,
  /^(error|not logged in|please run|usage:|command not found)/i,
  /^(as an ai|i don'?t have (access|enough))/i,
];

function looksLikeFailure(text: string): boolean {
  return FAILURE_OPENERS.some((pattern) => pattern.test(text));
}

/** Strips the packaging models add: fences, quotes, bullets, stray markdown. */
function unwrap(raw: string): string {
  return raw
    .replace(/^\s*```(?:\w+)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\*\*/g, '')
    .trim()
    .replace(/^["'“”](.*)["'“”]$/s, '$1')
    .trim();
}

/**
 * Where one sentence ends and the next begins.
 *
 * A full stop that ends a sentence, not every full stop. Descriptions of code are full
 * of `next.config.js` and `v1.2`, and cutting at the first dot turns "Reads config from
 * next.config.js and applies it" into "Reads config from next" — which is not a shorter
 * description, it is a wrong one. So a break has to be whitespace followed by something
 * that starts like a sentence.
 */
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=["'(\[]?[A-Z])/;

/**
 * A one-line description. Truncation is by sentence rather than by character: a
 * summary cut mid-word reads as a bug, and the first sentence is nearly always the
 * one worth keeping.
 */
export function cleanSentence(raw: unknown, maxWords = 24): string | null {
  if (typeof raw !== 'string') return null;
  let text = mendFilenames(unwrap(raw).replace(/\s+/g, ' '));
  if (!text || looksLikeFailure(text)) return null;

  const sentences = text.split(SENTENCE_BREAK);
  if (sentences.length > 1 && countWords(sentences[0]) >= 4) text = sentences[0].trim();

  if (countWords(text) > maxWords) {
    text = `${text.split(/\s+/).slice(0, maxWords).join(' ')}…`;
  }
  text = text.replace(/\.$/, '');
  return text.length >= 3 ? text : null;
}

/** A folder's plain-English name: a few words, no punctuation, no path. */
export function cleanLabel(raw: unknown, fallbackName: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = unwrap(raw).replace(/\s+/g, ' ').replace(/[.:;]+$/, '');
  if (!text || looksLikeFailure(text)) return null;
  if (countWords(text) > 4 || text.length > 34) return null;
  // A label that just re-spells the folder adds nothing and costs a line of screen.
  if (text.toLowerCase().replace(/[^a-z0-9]/g, '') === fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    return null;
  }
  return text;
}

/** The app overview: a few sentences, kept whole. */
export function cleanParagraph(raw: unknown, maxSentences = 6): string | null {
  if (typeof raw !== 'string') return null;
  const text = mendFilenames(unwrap(raw).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim());
  if (!text || looksLikeFailure(text)) return null;
  // The same boundary rule `cleanSentence` uses, and for the same reason. Splitting on
  // every full stop counts the dot in `analyze.py` as the end of a sentence — so a
  // paragraph naming fourteen scripts was cut after the sixth of them, and rejoining the
  // pieces with a space put one *inside* each filename. The model had written them
  // correctly; this is where they were broken.
  const sentences = text.split(SENTENCE_BREAK);
  const trimmed = sentences.length > maxSentences ? sentences.slice(0, maxSentences).join(' ') : text;
  return trimmed.length >= 20 ? trimmed.trim() : null;
}

// ---------------------------------------------------------------------------
// Holding a sentence to the endpoint table
// ---------------------------------------------------------------------------

/**
 * One door as the analyzer found it: the verb it answers to and the path it sits at.
 *
 * `method` is whatever the detector wrote there, which is not always an HTTP verb — a
 * page, a cron and a server action all get a word of their own — and is null where the
 * boundary has no verb at all.
 */
export interface KnownRoute {
  method: string | null;
  route: string | null;
}

/**
 * Every path the atlas knows, and every verb it knows for that path.
 *
 * Keyed by a normalised pattern, so `/api/posts/:postId`, `/api/posts/{postId}` and
 * `/api/posts/<postId>` are one entry rather than three. Build it with `methodsByRoute`
 * and hand it to `dropWrongMethods`.
 */
export type MethodsByRoute = Map<string, Set<string>>;

/** What a sentence survived, and what it was caught saying. */
export interface Grounded {
  /** The sentences that survived, rejoined. Null when none of them did. */
  text: string | null;
  /** Claims we disproved, written as the model paired them: `GET /api/posts`. */
  wrong: string[];
}

/**
 * The verbs a URL can answer to.
 *
 * Everything else that turns up in `method` — `PAGE`, `CRON`, `ANY`, `ACTION` — is a
 * detector's own word for a door that is not an HTTP verb, and a path we only know by
 * one of those is a path we cannot hold anybody to.
 */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/** The characters a URL path is spelled with, including every way to write a parameter. */
const PATH_CHARS = String.raw`\w\-~%+.$*:{}<>\[\]`;

/**
 * A path named in a sentence.
 *
 * The lookbehind is what keeps `https://api.stripe.com/v1/charges` and `and/or` out:
 * a path we care about starts after a space, a bracket or the start of the line, never
 * in the middle of a word and never after the `//` of a scheme.
 */
const PATH_MENTION = new RegExp(String.raw`(?<![\w:/])/[${PATH_CHARS}]+(?:/[${PATH_CHARS}]*)*`, 'g');

/**
 * A segment that stands for a value instead of being one.
 *
 * Every framework spells this differently — `:postId`, `{postId}`, `<postId>`,
 * `[postId]`, `[...slug]`, `*` — and a model rewriting a route in prose reaches for
 * whichever spelling it has seen most, not the one its own repository uses.
 */
const PARAM_SEGMENT = /^(?::.+|\{.*\}|<.*>|\[.*\]|\*+)$/;

/** Words allowed to stand between a verb and the path it is about. */
const FILLER = new Set([
  'a', 'an', 'the', 'to', 'at', 'on', 'from', 'via', 'through', 'with', 'by', 'using',
  'request', 'requests', 'call', 'calls', 'endpoint', 'endpoints', 'route', 'routes',
  'handler', 'handlers', 'its', 'your', 'our', 'their', 'this', 'that',
]);

/** `GET and DELETE /api/posts` is two claims about one path, so a joiner does not stop the scan. */
const JOINERS = new Set(['and', 'or']);

/** How far either side of a path a verb can sit and still be about it. */
const WORDS_BEFORE = 4;
const WORDS_AFTER = 2;

/**
 * Builds the table `dropWrongMethods` checks against, out of the endpoints the analyzer
 * found. Doors with no path — a cron expression, a queue name, a CLI command — are left
 * out, because there is nothing in a sentence for them to be matched against.
 */
export function methodsByRoute(routes: KnownRoute[]): MethodsByRoute {
  const table: MethodsByRoute = new Map();
  for (const { method, route } of routes) {
    const key = route ? pathPattern(route) : null;
    if (!key) continue;
    const verbs = table.get(key);
    // An empty string stands for "found the door, never learned the verb", which is not
    // the same as knowing it answers to nothing.
    if (verbs) verbs.add((method ?? '').toUpperCase());
    else table.set(key, new Set([(method ?? '').toUpperCase()]));
  }
  return table;
}

/**
 * Drops any sentence that pairs one of your routes with a verb the route does not have.
 *
 * The bug this exists for: an overview said saving happened at `GET /api/posts` and
 * `DELETE /api/posts/:postId` when the real save routes were POST and PATCH. Every door
 * named was real — only the verbs were invented — and the sentence sat directly beside
 * compiler-derived facts with nothing to mark it as the one thing on the page that
 * nobody had checked. A reader who cannot read code cannot check it either, and "your
 * save endpoint is a GET" is exactly the sentence that derails a meeting.
 *
 * Three decisions worth knowing about, because each one is a place this could have been
 * stricter or looser:
 *
 * - **The unit dropped is the sentence.** A clause is smaller, but excising one leaves
 *   prose nobody wrote — and rewriting `GET` to `POST` would be worse still, because the
 *   whole design of the explanation ladder is that generated text is labelled and
 *   droppable, never edited into agreement with the facts. The whole description is
 *   bigger than the damage: an overview is several sentences drawn from several
 *   different facts, and one bad verb should not take the folder tour with it.
 *
 * - **A path named with no verb at all is allowed through.** "Posts are saved through
 *   /api/posts" claims nothing about a method, so there is nothing to disagree with, and
 *   naming the door is the useful half of the sentence. Only a stated pair can be wrong.
 *
 * - **A path we have no record of is left alone.** The atlas being silent about a route
 *   means nobody could see it, not that it does not exist, so an unknown path is not
 *   evidence of an invented one. This drops what we can disprove, not what we cannot
 *   confirm.
 *
 * What it settles is whether the pair exists, not whether the sentence around it is
 * true. A path that answers to both GET and POST cannot be caught here calling the wrong
 * one of them the way to save something — that would take reading the handler, not the
 * table.
 */
export function dropWrongMethods(text: string, routes: MethodsByRoute): Grounded {
  if (routes.size === 0) return { text, wrong: [] };

  const wrong: string[] = [];
  const kept = text.split(SENTENCE_BREAK).filter((sentence) => {
    const disproved = disprovenClaims(sentence, routes);
    wrong.push(...disproved);
    return disproved.length === 0;
  });

  const joined = kept.join(' ').trim();
  return { text: joined.length > 0 ? joined : null, wrong };
}

/** Every `VERB /path` pairing in one sentence that the endpoint table contradicts. */
function disprovenClaims(sentence: string, routes: MethodsByRoute): string[] {
  const disproved: string[] = [];
  for (const match of sentence.matchAll(PATH_MENTION)) {
    const mention = trimPunctuation(match[0]);
    const verbs = verbsFor(mention, routes);
    if (!verbs) continue;
    for (const claimed of claimedMethods(sentence, match.index, match[0].length)) {
      if (!verbs.has(claimed)) disproved.push(`${claimed} ${mention}`);
    }
  }
  return disproved;
}

/**
 * Every verb the atlas has for the path a sentence just named, or null when the claim
 * cannot be settled either way — the path is not one of ours, or one of the doors at it
 * is a page or a cron rather than something with an HTTP verb.
 */
function verbsFor(mention: string, routes: MethodsByRoute): Set<string> | null {
  const wanted = pathPattern(mention);
  if (!wanted) return null;

  const wantedParts = wanted.split('/');
  const verbs = new Set<string>();
  let found = false;

  for (const [known, methods] of routes) {
    const knownParts = known.split('/');
    // Same number of segments, and every literal one identical. That is what keeps a
    // parameter from swallowing the rest of a path: `/api/posts/{}` is not `/api/posts`
    // and it is not `/api/posts/{}/comments`.
    if (knownParts.length !== wantedParts.length) continue;
    if (!knownParts.every((part, index) => segmentMatches(wantedParts[index], part))) continue;

    found = true;
    for (const method of methods) {
      if (!HTTP_METHODS.has(method)) return null;
      verbs.add(method);
    }
  }
  return found ? verbs : null;
}

/**
 * Whether one segment of a mentioned path fits the same segment of a known one.
 *
 * Deliberately one-way. A parameter slot in the atlas accepts anything, including a
 * value the model wrote out in full, so `/api/posts/123` still matches
 * `/api/posts/:postId`. A parameter the *model* wrote does not match a literal segment
 * in the atlas, because `/api/posts/:id` is not a claim about `/api/posts/count`.
 */
function segmentMatches(mentioned: string, known: string): boolean {
  if (known === '{}') return true;
  if (mentioned === '{}') return false;
  return mentioned === known;
}

/** A path reduced to what identifies it: lower case, no query, parameters anonymised. */
function pathPattern(raw: string): string | null {
  const path = raw.split(/[?#]/)[0];
  if (!path.startsWith('/')) return null;
  const parts = path.split('/').slice(1);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return `/${parts.map((part) => (PARAM_SEGMENT.test(part) ? '{}' : part.toLowerCase())).join('/')}`;
}

/**
 * The verbs a sentence attaches to the path at `index`.
 *
 * Only capitalised verbs count. Models write HTTP methods in capitals — the facts we
 * hand them are written that way too — while "the post at /api/posts" and "the options
 * at /settings" are English nouns that happen to be spelled like methods. Reading those
 * as claims would delete good sentences, so the rule is: shout it or it is not a claim.
 * The cost is that a lower-case "a get request to /api/users" goes unchecked, which
 * leaves a sentence standing rather than removing a true one.
 */
function claimedMethods(sentence: string, index: number, length: number): string[] {
  const claimed: string[] = [];

  for (const word of wordsIn(sentence.slice(0, index)).slice(-WORDS_BEFORE).reverse()) {
    const method = asMethod(word);
    if (method) claimed.push(method);
    else if (!FILLER.has(word.toLowerCase()) && !JOINERS.has(word.toLowerCase())) break;
  }

  for (const word of wordsIn(sentence.slice(index + length)).slice(0, WORDS_AFTER)) {
    const method = asMethod(word);
    if (method) {
      claimed.push(method);
      break;
    }
    // No joiners here: in "saves at /api/posts and GET /api/orders lists them" the verb
    // after the `and` belongs to the next path, not to this one.
    if (!FILLER.has(word.toLowerCase())) break;
  }

  return claimed;
}

/** `POST` and `POSTs` are the same claim; `post` and `posts` are ordinary words. */
function asMethod(word: string): string | null {
  const bare = /^([A-Z]+)s?$/.exec(word)?.[1];
  return bare && HTTP_METHODS.has(bare) ? bare : null;
}

function wordsIn(text: string): string[] {
  return text.split(/[^A-Za-z]+/).filter(Boolean);
}

/**
 * Trims the punctuation a sentence leaves stuck to a path, without eating the bracket
 * that closes a parameter: the `)` in "(see /api/posts)" is the sentence's, the `]` in
 * `/posts/[id]` is the route's.
 */
function trimPunctuation(token: string): string {
  let out = token.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]) {
    while (out.endsWith(close) && occurrences(out, close) > occurrences(out, open)) {
      out = out.slice(0, -1);
    }
  }
  return out.replace(/[.,;:!?]+$/, '');
}

function occurrences(text: string, character: string): number {
  let total = 0;
  for (const char of text) if (char === character) total++;
  return total;
}

/** File extensions common enough that a space in front of one is always a mistake. */
const EXTENSIONS =
  'py|pyi|ipynb|ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|toml|yaml|yml|sql|css|scss|html|sh|env|lock|txt|rs|go|rb|java|kt|swift|php|cs|prisma';

/**
 * Puts back a filename that arrived with a space inside it.
 *
 * powerfab-dashboard's summary read "01_list_tables. py", "02_describe_tables. py" —
 * four times in one paragraph. A model wraps its own output, the wrap lands mid-token,
 * and collapsing whitespace turns the newline into a space. A reader who cannot read
 * code has no way to tell that from a real file name, so they go looking for one that
 * is not there.
 *
 * Safe because there is no English sentence in which a word, a full stop and a space
 * are followed by a bare file extension.
 */
function mendFilenames(text: string): string {
  return text.replace(new RegExp(`([\\w)\\]])\\.\\s+(${EXTENSIONS})\\b`, 'g'), '$1.$2');
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
