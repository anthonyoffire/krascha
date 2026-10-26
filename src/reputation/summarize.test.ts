import { describe, expect, it } from 'vitest';

import { COPIES_PER_DAY } from '../shared/leaderboard.js';
import { MEAN_WEIGHT, reputationScore, SCORE_DAMPING } from '../shared/reputation.js';

import type { HitEntry, ReputationIndex } from './store.js';
import { emptyIndex } from './store.js';
import type { TokenCounts } from './summarize.js';
import { dayOf, RECENT_HITS, summarize, TOP_TERMS } from './summarize.js';

const NO_TOKENS: TokenCounts = {
  tokensPerDay: 0,
  lifetimeTokens: 0,
  copilotTokensPerDay: 0,
  copilotLifetimeTokens: 0,
};

// Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
const DAY1 = Date.UTC(2026, 9, 1, 12);
const DAY2 = Date.UTC(2026, 9, 2, 12);

interface Said {
  readonly mean?: HitEntry;
  readonly kind?: readonly string[];
}

function put(
  index: ReputationIndex,
  id: string,
  prompt: { readonly sessionId: string; readonly at: number; readonly print?: string },
  said: Said = {},
): void {
  index.prompts.set(id, prompt);
  if (said.mean !== undefined) {
    index.hits.set(id, said.mean);
  }
  if (said.kind !== undefined) {
    index.kind.set(id, { terms: said.kind, excerpt: said.kind.join(' ') });
  }
}

function hit(target: HitEntry['target'], ...terms: string[]): HitEntry {
  return { terms, target, excerpt: terms.join(' ') };
}

const title = (sessionId: string): string => `title ${sessionId}`;

describe('reputationScore', () => {
  it('is 0 with nothing said, leans with each side and weighs mean prompts more', () => {
    expect(reputationScore({ kind: 0, mean: 0 })).toBe(0);
    expect(reputationScore({ kind: 1, mean: 0 })).toBe(1 / (1 + SCORE_DAMPING));
    expect(reputationScore({ kind: 0, mean: 1 })).toBe(
      -MEAN_WEIGHT / (MEAN_WEIGHT + SCORE_DAMPING),
    );
    expect(reputationScore({ kind: MEAN_WEIGHT, mean: 1 })).toBe(0);
    expect(reputationScore({ kind: 10_000, mean: 0 })).toBeGreaterThan(0.99);
    expect(reputationScore({ kind: 0, mean: 10_000 })).toBeLessThan(-0.99);
  });
});

describe('dayOf', () => {
  it('gives the local date padded', () => {
    expect(dayOf(DAY1)).toBe('2026-10-01');
    expect(dayOf(Date.UTC(2026, 0, 5, 12))).toBe('2026-01-05');
    expect(dayOf(Date.UTC(2026, 11, 25, 12))).toBe('2026-12-25');
  });
});

describe('summarize', () => {
  it('is empty for an empty index', () => {
    expect(summarize(emptyIndex(), title, NO_TOKENS)).toStrictEqual({
      prompts: 0,
      kind: 0,
      mean: 0,
      general: 0,
      score: 0,
      byDay: [],
      bySession: [],
      topKind: [],
      topMean: [],
      recent: [],
      scannedAt: null,
      tokensPerDay: 0,
      lifetimeTokens: 0,
      copilotTokensPerDay: 0,
      copilotLifetimeTokens: 0,
      hours: 0,
      tools: [],
      lateNight: 0,
      selfAware: 0,
      mixed: 0,
      swarm: 0,
      rageQuits: 0,
      badWords: 0,
      copies: 0,
      sorryAt: null,
      roleplay: 0,
    });
  });

  it('reports the one-time roleplay flag', () => {
    const index = emptyIndex();
    index.roleplay = true;
    expect(summarize(index, title, NO_TOKENS).roleplay).toBe(1);
  });

  it('counts prompts typed late at night, at 2:14 a.m. and both kind and mean', () => {
    const index = emptyIndex();
    const at = (hours: number, minutes: number): number =>
      new Date(2026, 7, 29, hours, minutes).getTime();
    put(index, 'claude:a', { sessionId: 's1', at: at(0, 0) });
    put(index, 'claude:b', { sessionId: 's1', at: at(2, 14) }, { kind: ['please'] });
    put(
      index,
      'claude:c',
      { sessionId: 's1', at: at(4, 59) },
      { kind: ['please'], mean: hit('agent', 'idiot') },
    );
    put(
      index,
      'claude:d',
      { sessionId: 's1', at: at(5, 0) },
      { kind: ['thanks'], mean: hit('general', 'damn') },
    );
    put(index, 'claude:e', { sessionId: 's1', at: at(14, 14) }, { mean: hit('agent', 'idiot') });
    const summary = summarize(index, title, NO_TOKENS);
    expect(summary.lateNight).toBe(3);
    expect(summary.selfAware).toBe(1);
    expect(summary.mixed).toBe(1);
  });

  it('counts sessions typed into at once, sessions that end mean and different bad words', () => {
    const index = emptyIndex();
    const minute = 60_000;
    put(index, 'a', { sessionId: 's1', at: DAY1 }, { mean: hit('agent', 'idiot', 'shit') });
    put(index, 'b', { sessionId: 's2', at: DAY1 + 5 * minute }, { mean: hit('general', 'shit') });
    put(index, 'c', { sessionId: 's3', at: DAY1 + 15 * minute }, { mean: hit('agent', 'lazy') });
    put(index, 'd', { sessionId: 's1', at: DAY1 + 16 * minute });
    put(index, 'e', { sessionId: 's4', at: DAY1 + 31 * minute });
    put(index, 'f', { sessionId: 's5', at: DAY1 + 31 * minute }, { kind: ['please'] });
    const state = summarize(index, title, NO_TOKENS);
    expect(state.swarm).toBe(3);
    expect(state.rageQuits).toBe(1);
    expect(state.badWords).toBe(3);
  });

  it('totals kind, mean and general prompts by day and by session', () => {
    const index = emptyIndex();
    index.scannedAt = 9;
    put(index, 'a', { sessionId: 's1', at: DAY2 }, { mean: hit('agent', 'idiot') });
    put(
      index,
      'b',
      { sessionId: 's1', at: DAY2 + 1 },
      { mean: hit('general', 'shit', 'fuck'), kind: ['please'] },
    );
    put(index, 'c', { sessionId: 's1', at: DAY1 });
    put(index, 'd', { sessionId: 's2', at: DAY1 }, { mean: hit('general', 'shit') });
    put(index, 'e', { sessionId: 's3', at: DAY1 }, { kind: ['thanks', 'please'] });
    put(index, 'f', { sessionId: 's4', at: DAY1 }, { mean: hit('agent', 'idiot') });
    put(index, 'g', { sessionId: 's4', at: DAY1 });
    put(index, 'h', { sessionId: 's5', at: DAY1 });
    const state = summarize(index, title, NO_TOKENS);
    expect(state).toMatchObject({ prompts: 8, kind: 2, mean: 2, general: 2, scannedAt: 9 });
    expect(state.score).toBe(reputationScore({ kind: 2, mean: 2 }));
    expect(state.byDay).toStrictEqual([
      { date: '2026-10-01', prompts: 6, kind: 1, mean: 1, general: 1 },
      { date: '2026-10-02', prompts: 2, kind: 1, mean: 1, general: 1 },
    ]);
    const meanOnce = reputationScore({ kind: 0, mean: 1 });
    expect(state.bySession).toStrictEqual(
      [
        {
          sessionId: 's1',
          title: 'title s1',
          prompts: 3,
          kind: 1,
          mean: 1,
          general: 1,
          score: reputationScore({ kind: 1, mean: 1 }),
        },
        {
          sessionId: 's4',
          title: 'title s4',
          prompts: 2,
          kind: 0,
          mean: 1,
          general: 0,
          score: meanOnce,
        },
        { sessionId: 's2', title: 'title s2', prompts: 1, kind: 0, mean: 0, general: 1, score: 0 },
        {
          sessionId: 's3',
          title: 'title s3',
          prompts: 1,
          kind: 1,
          mean: 0,
          general: 0,
          score: reputationScore({ kind: 1, mean: 0 }),
        },
      ].toSorted((left, right) => left.score - right.score || right.prompts - left.prompts),
    );
    expect(state.topKind).toStrictEqual([
      { term: 'please', count: 2 },
      { term: 'thanks', count: 1 },
    ]);
    expect(state.topMean).toStrictEqual([
      { term: 'idiot', count: 2 },
      { term: 'shit', count: 2 },
      { term: 'fuck', count: 1 },
    ]);
    expect(state.recent.map((item) => item.id)).toStrictEqual([
      'b:general',
      'b:kind',
      'a:mean',
      'd:general',
      'e:kind',
      'f:mean',
    ]);
    expect(state.recent[1]).toStrictEqual({
      id: 'b:kind',
      sessionId: 's1',
      at: DAY2 + 1,
      tone: 'kind',
      terms: ['please'],
      excerpt: 'please',
    });
  });

  it('names the agents the prompts were typed into, Claude Code first', () => {
    const index = emptyIndex();
    put(index, 'c:e1', { sessionId: 's1', at: DAY1 });
    expect(summarize(index, title, NO_TOKENS).tools).toStrictEqual(['copilot']);
    put(index, 'h:x', { sessionId: 's2', at: DAY1 });
    put(index, 't:u1', { sessionId: 's3', at: DAY1 });
    expect(summarize(index, title, NO_TOKENS).tools).toStrictEqual(['claude', 'copilot']);
  });

  it('counts each kind or mean prompt typed more than 10 times in a day past the 10th', () => {
    const index = emptyIndex();
    const typed = (print: string, at: number, times: number): void => {
      for (let count = 0; count < times; count += 1) {
        put(index, `${print} ${String(at)} ${String(count)}`, { sessionId: 's1', at, print });
      }
    };
    typed('aaaa', DAY1, COPIES_PER_DAY);
    typed('aaaa', DAY2, COPIES_PER_DAY);
    expect(summarize(index, title, NO_TOKENS).copies).toBe(0);
    typed('bbbb', DAY1, COPIES_PER_DAY + 3);
    typed('cccc', DAY2, COPIES_PER_DAY + 1);
    put(index, 'plain', { sessionId: 's1', at: DAY1 });
    expect(summarize(index, title, NO_TOKENS).copies).toBe(4);
  });

  it('breaks session ties by id', () => {
    const index = emptyIndex();
    put(index, 'a', { sessionId: 'zz', at: DAY1 }, { mean: hit('agent', 'x') });
    put(index, 'b', { sessionId: 'aa', at: DAY1 }, { mean: hit('agent', 'x') });
    expect(summarize(index, title, NO_TOKENS).bySession.map((row) => row.sessionId)).toStrictEqual([
      'aa',
      'zz',
    ]);
  });

  it('keeps the top terms and the newest hits only', () => {
    const index = emptyIndex();
    for (let count = 0; count < RECENT_HITS + 1; count += 1) {
      put(
        index,
        `p${String(count)}`,
        { sessionId: 's', at: DAY1 + count },
        { mean: hit('general', `t${String(count % 12)}`) },
      );
    }
    const state = summarize(index, title, NO_TOKENS);
    expect(state.recent).toHaveLength(RECENT_HITS);
    expect(state.recent[0]?.id).toBe('p50:general');
    expect(state.recent.at(-1)?.id).toBe('p1:general');
    expect(state.topMean).toHaveLength(TOP_TERMS);
    expect(state.topMean.slice(0, 4)).toStrictEqual([
      { term: 't0', count: 5 },
      { term: 't1', count: 5 },
      { term: 't2', count: 5 },
      { term: 't10', count: 4 },
    ]);
  });

  it('skips hits whose prompt is missing', () => {
    const index = emptyIndex();
    index.hits.set('lost', hit('agent', 'x'));
    index.kind.set('lost', { terms: ['please'], excerpt: 'please' });
    expect(summarize(index, title, NO_TOKENS)).toMatchObject({ recent: [], mean: 0, kind: 0 });
  });
});
