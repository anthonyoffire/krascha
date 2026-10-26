// Finds abusive or frustrated language in one prompt and decides whether it
// was aimed at the agent or was general swearing. The word matching here is
// shared with the kindness detector.

import { createHash } from 'node:crypto';

import { stripIgnored } from './clean.js';
import type { LexiconEntry } from './lexicon.js';
import {
  APOLOGY_LEXICON,
  DETERMINERS,
  KIND_LEXICON,
  LEXICON,
  NOT_TYPOS,
  SECOND_PERSON,
} from './lexicon.js';

/** Aimed at the agent the prompt was typed to, or swearing at the world. */
export type FrustrationTarget = 'agent' | 'general';

export interface Detection {
  /** Terms in the order they first appear, each once. */
  readonly terms: readonly string[];
  readonly target: FrustrationTarget;
  readonly excerpt: string;
}

export interface Token {
  readonly word: string;
  readonly start: number;
  readonly sentence: number;
}

/** A term shown in the report and the normalized spellings that count as it. */
export interface Term {
  readonly term: string;
  readonly forms: readonly string[];
  /** Words that, right after a form, make it something else ("lazy loading"). */
  readonly notBefore?: readonly string[];
}

interface Form<E extends Term> {
  readonly entry: E;
  readonly words: readonly string[];
}

export interface Match<E extends Term> {
  readonly entry: E;
  readonly token: Token;
  /** Index of the first token. */
  readonly first: number;
  /** Index of the token after the match. */
  readonly next: number;
}

export type Forms<E extends Term> = ReadonlyMap<string, readonly Form<E>[]>;

export const EXCERPT_CHARS = 80;
const EXCERPT_LEAD = 30;

const TOKEN = /[\p{L}\p{N}*'’]+/gu;
const APOSTROPHES = /['’]/gu;
const REPEATS = /(\p{L})\1{2,}/gu;
const BOUNDARY = /[.!?;\n]/u;
const SPACES = /\s+/gu;
const AFTER_FIRST_WORD = / .*/u;
const STARS = /\*+/gu;
const LETTERS = /^\p{L}+$/u;
const HAS_LETTER = /\p{L}/u;
const LEET = /[013457]/gu;
const DIGIT_LETTERS: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/** Shortest form that gets typo spellings. Shorter ones are too close to real words (duck, as). */
export const TYPO_MIN = 4;
/** Dropping a letter from a short word lands on a real one too often, so only longer forms get it. */
export const DROP_MIN = 5;

/**
 * Lowercase, apostrophes removed, runs of stars made one, a star at either
 * end dropped (*idiot* reads as idiot) and long letter runs folded.
 */
export function normalizeWord(raw: string): string {
  const squeezed = raw.toLowerCase().replaceAll(APOSTROPHES, '').replaceAll(STARS, '*');
  const start = squeezed.startsWith('*') ? 1 : 0;
  const end = squeezed.endsWith('*') ? squeezed.length - 1 : squeezed.length;
  return squeezed.slice(start, Math.max(start, end)).replaceAll(REPEATS, '$1');
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sentence = 0;
  let last = 0;
  for (const found of text.matchAll(TOKEN)) {
    if (BOUNDARY.test(text.slice(last, found.index))) {
      sentence += 1;
    }
    last = found.index + found[0].length;
    const word = normalizeWord(found[0]);
    if (word !== '') {
      tokens.push({ word, start: found.index, sentence });
    }
  }
  return tokens;
}

/** Every form keyed by its first word, longest first so a phrase beats its first word. */
export function buildForms<E extends Term>(entries: readonly E[]): Forms<E> {
  const byFirst = new Map<string, Form<E>[]>();
  for (const entry of entries) {
    for (const form of entry.forms) {
      const key = form.replace(AFTER_FIRST_WORD, '');
      byFirst.set(key, [...(byFirst.get(key) ?? []), { entry, words: form.split(' ') }]);
    }
  }
  for (const [key, forms] of byFirst) {
    byFirst.set(
      key,
      forms.toSorted((left, right) => right.words.length - left.words.length),
    );
  }
  return byFirst;
}

/**
 * Spellings one slip from `form`: two letters next to each other swapped
 * (fcuk), a letter doubled (idiiot) or, in longer words, a letter dropped
 * (stupd).
 */
export function typosOf(form: string): string[] {
  if (form.length < TYPO_MIN || !LETTERS.test(form)) {
    return [];
  }
  const typos = new Set<string>();
  for (let at = 0; at < form.length; at += 1) {
    const letter = form.charAt(at);
    const next = form.charAt(at + 1);
    if (next !== '' && next !== letter) {
      typos.add(form.slice(0, at) + next + letter + form.slice(at + 2));
    }
    // Doubling a letter that is already doubled would fold back to one.
    if (next !== letter && form.charAt(at - 1) !== letter) {
      typos.add(form.slice(0, at + 1) + form.slice(at));
    }
    if (form.length >= DROP_MIN) {
      typos.add(form.slice(0, at) + form.slice(at + 1));
    }
  }
  typos.delete(form);
  return [...typos];
}

/** Each entry again with the typos of its one word forms, minus real words and spellings a term already has. */
export function typoEntries<E extends Term>(entries: readonly E[]): E[] {
  const taken = new Set(
    entries.flatMap((entry) => entry.forms.map((form) => form.replace(AFTER_FIRST_WORD, ''))),
  );
  return entries.map((entry) => ({
    ...entry,
    forms: [
      ...new Set(
        entry.forms.flatMap(typosOf).filter((typo) => !taken.has(typo) && !NOT_TYPOS.has(typo)),
      ),
    ],
  }));
}

/** sh1t reads as shit. Only in words that also have a letter, so plain numbers stay numbers. */
export function unleet(word: string): string {
  return HAS_LETTER.test(word)
    ? word.replaceAll(LEET, (digit) => DIGIT_LETTERS[digit] ?? digit)
    : word;
}

/** Bump when the matching changes but the word lists do not, so every prompt is counted again. */
const MATCH_RULES = 2;

/** Changes whenever the words or the matching change. The index saves it to know when to count again. */
export const DETECTION_STAMP = createHash('sha256')
  .update(
    JSON.stringify([
      MATCH_RULES,
      LEXICON,
      KIND_LEXICON,
      APOLOGY_LEXICON,
      [...NOT_TYPOS],
      [...DETERMINERS],
      [...SECOND_PERSON],
    ]),
  )
  .digest('hex')
  .slice(0, 16);

// Exact forms come first, so a typo never beats a real spelling.
const FORMS = buildForms([...LEXICON, ...typoEntries(LEXICON)]);

function formAt<E extends Term>(
  forms: Forms<E>,
  tokens: readonly Token[],
  index: number,
  word: string,
): Form<E> | undefined {
  return forms
    .get(word)
    ?.find((form) =>
      form.words.every((expected, offset) => tokens[index + offset]?.word === expected),
    );
}

export function findMatches<E extends Term>(forms: Forms<E>, tokens: readonly Token[]): Match<E>[] {
  const matches: Match<E>[] = [];
  // Tokens inside a phrase that already matched are not read again.
  let next = 0;
  for (const [index, token] of tokens.entries()) {
    const form = index < next ? undefined : formAt(forms, tokens, index, token.word);
    const after = tokens[index + (form?.words.length ?? 0)]?.word ?? '';
    if (form !== undefined && form.entry.notBefore?.includes(after) !== true) {
      next = index + form.words.length;
      matches.push({ entry: form.entry, token, first: index, next });
    }
  }
  return matches;
}

function isAimed(
  match: Match<LexiconEntry>,
  tokens: readonly Token[],
  spoken: ReadonlySet<number>,
): boolean {
  if (spoken.has(match.token.sentence) || match.entry.kind === 'aimed') {
    return true;
  }
  // A swear followed by "me" ("fuck me") counts as aimed too.
  const after = tokens[match.next];
  if (
    match.entry.kind === 'swear' &&
    after?.word === 'me' &&
    after.sentence === match.token.sentence
  ) {
    return true;
  }
  const before = tokens[match.first - 1]?.word ?? '';
  return match.entry.kind === 'insult' && !DETERMINERS.has(before);
}

/** About EXCERPT_CHARS of text around `start`, on one line, with ... where it was cut. */
export function excerptAround(text: string, start: number): string {
  const from = Math.max(0, Math.min(start - EXCERPT_LEAD, text.length - EXCERPT_CHARS));
  const to = Math.min(text.length, from + EXCERPT_CHARS);
  const body = text.slice(from, to).replaceAll(SPACES, ' ').trim();
  return `${from > 0 ? '...' : ''}${body}${to < text.length ? '...' : ''}`;
}

/** The frustration in a prompt, or null when there is none. */
export function detectFrustration(text: string): Detection | null {
  const cleaned = stripIgnored(text);
  const tokens = tokenize(cleaned).map((token) => ({ ...token, word: unleet(token.word) }));
  const matches = findMatches(FORMS, tokens);
  const [first] = matches;
  if (first === undefined) {
    return null;
  }
  const spoken = new Set(
    tokens.filter((token) => SECOND_PERSON.has(token.word)).map((token) => token.sentence),
  );
  const aimed = matches.some((match) => isAimed(match, tokens, spoken));
  return {
    terms: [...new Set(matches.map((match) => match.entry.term))],
    target: aimed ? 'agent' : 'general',
    excerpt: excerptAround(cleaned, first.token.start),
  };
}
