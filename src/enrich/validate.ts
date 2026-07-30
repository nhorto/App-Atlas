/**
 * @fileoverview The gate between a model's reply and the atlas.
 *
 * Nothing generated is trusted on the way in. A reply can be wrapped in a markdown
 * fence, prefixed with "Sure! Here's the JSON:", contain keys we never asked about,
 * or be an error message that a shell dutifully printed to stdout. Every one of those
 * has to bounce off this file, because the alternative is a wrong sentence displayed
 * next to a compiler-derived fact with nothing to tell them apart.
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
