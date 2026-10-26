// Turns the index into the report: totals, the score, a row per day, a
// row per session, the most common kind and mean terms and the newest hits.
// The token counts come from the usage stats, so the caller passes them in.
// The hours come from when each prompt was typed.

import { COPIES_PER_DAY } from '../shared/leaderboard.js';
import type { ReputationHit, ReputationSummary } from '../shared/reputation.js';
import { reputationScore } from '../shared/reputation.js';
import type { ToolId } from '../shared/tools.js';
import { knownTools, toolOf } from '../shared/tools.js';

import { hoursSpent } from './hours.js';
import type { ReputationIndex } from './store.js';

export const TOP_TERMS = 10;
export const RECENT_HITS = 50;
/** The hour late night ends, so midnight to 5 a.m. counts. */
const LATE_NIGHT_ENDS = 5;
/** How close together prompts in different sessions count as one swarm. */
const SWARM_MS = 15 * 60_000;

type SessionRow = ReputationSummary['bySession'][number];

/** Local calendar date, YYYY-MM-DD. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

interface Tally {
  prompts: number;
  kind: number;
  mean: number;
  general: number;
}

function tallyFor(map: Map<string, Tally>, key: string): Tally {
  const found = map.get(key);
  if (found !== undefined) {
    return found;
  }
  const fresh: Tally = { prompts: 0, kind: 0, mean: 0, general: 0 };
  map.set(key, fresh);
  return fresh;
}

function hitsOf(index: ReputationIndex): ReputationHit[] {
  const hits: ReputationHit[] = [];
  for (const [id, prompt] of index.prompts) {
    const mean = index.hits.get(id);
    if (mean !== undefined) {
      const tone = mean.target === 'agent' ? 'mean' : 'general';
      hits.push({ id: `${id}:${tone}`, sessionId: prompt.sessionId, at: prompt.at, tone, ...mean });
    }
    const kind = index.kind.get(id);
    if (kind !== undefined) {
      hits.push({
        id: `${id}:kind`,
        sessionId: prompt.sessionId,
        at: prompt.at,
        tone: 'kind',
        ...kind,
      });
    }
  }
  return hits;
}

function topTerms(hits: readonly ReputationHit[]): ReputationSummary['topKind'] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    for (const term of hit.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([term, count]) => ({ term, count }))
    .toSorted((left, right) => right.count - left.count || left.term.localeCompare(right.term))
    .slice(0, TOP_TERMS);
}

/** The most sessions with a prompt inside any SWARM_MS stretch. */
function mostSessionsAtOnce(
  prompts: readonly { readonly sessionId: string; readonly at: number }[],
): number {
  const sorted = prompts.toSorted((left, right) => left.at - right.at);
  const open = new Map<string, number>();
  let start = 0;
  let best = 0;
  for (const prompt of sorted) {
    open.set(prompt.sessionId, (open.get(prompt.sessionId) ?? 0) + 1);
    let first = sorted[start];
    while (first !== undefined && prompt.at - first.at > SWARM_MS) {
      const left = (open.get(first.sessionId) ?? 1) - 1;
      if (left === 0) {
        open.delete(first.sessionId);
      } else {
        open.set(first.sessionId, left);
      }
      start += 1;
      first = sorted[start];
    }
    best = Math.max(best, open.size);
  }
  return best;
}

function sessionRows(
  sessions: ReadonlyMap<string, Tally>,
  titleOf: (sessionId: string) => string,
): SessionRow[] {
  return [...sessions]
    .filter(([, tally]) => tally.kind + tally.mean + tally.general > 0)
    .map(([sessionId, tally]) => ({
      sessionId,
      title: titleOf(sessionId),
      ...tally,
      score: reputationScore(tally),
    }))
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        right.prompts - left.prompts ||
        left.sessionId.localeCompare(right.sessionId),
    );
}

export type TokenCounts = Pick<
  ReputationSummary,
  'tokensPerDay' | 'lifetimeTokens' | 'copilotTokensPerDay' | 'copilotLifetimeTokens'
>;

export function summarize(
  index: ReputationIndex,
  titleOf: (sessionId: string) => string,
  tokens: TokenCounts,
): ReputationSummary {
  const total: Tally = { prompts: 0, kind: 0, mean: 0, general: 0 };
  const days = new Map<string, Tally>();
  const sessions = new Map<string, Tally>();
  const tools = new Set<ToolId>();
  const clock = { lateNight: 0, selfAware: 0, mixed: 0 };
  const last = new Map<string, { at: number; mean: boolean }>();
  const typedToday = new Map<string, number>();
  let sorryAt: number | null = null;
  for (const [id, prompt] of index.prompts) {
    tools.add(toolOf(id));
    const target = index.hits.get(id)?.target;
    const kind = index.kind.has(id);
    const typed = new Date(prompt.at);
    clock.lateNight += typed.getHours() < LATE_NIGHT_ENDS ? 1 : 0;
    clock.selfAware += typed.getHours() === 2 && typed.getMinutes() === 14 ? 1 : 0;
    clock.mixed += kind && target === 'agent' ? 1 : 0;
    if (prompt.sorry === true && (sorryAt === null || prompt.at > sorryAt)) {
      sorryAt = prompt.at;
    }
    if (prompt.print !== undefined) {
      const key = `${dayOf(prompt.at)} ${prompt.print}`;
      typedToday.set(key, (typedToday.get(key) ?? 0) + 1);
    }
    const before = last.get(prompt.sessionId);
    if (before === undefined || prompt.at >= before.at) {
      last.set(prompt.sessionId, { at: prompt.at, mean: target === 'agent' });
    }
    for (const tally of [
      total,
      tallyFor(days, dayOf(prompt.at)),
      tallyFor(sessions, prompt.sessionId),
    ]) {
      tally.prompts += 1;
      tally.kind += kind ? 1 : 0;
      tally.mean += target === 'agent' ? 1 : 0;
      tally.general += target === 'general' ? 1 : 0;
    }
  }
  const hits = hitsOf(index);
  const bad = hits.filter((hit) => hit.tone !== 'kind');
  return {
    ...total,
    score: reputationScore(total),
    byDay: [...days]
      .map(([date, tally]) => ({ date, ...tally }))
      .toSorted((left, right) => left.date.localeCompare(right.date)),
    bySession: sessionRows(sessions, titleOf),
    topKind: topTerms(hits.filter((hit) => hit.tone === 'kind')),
    topMean: topTerms(bad),
    recent: hits.toSorted((left, right) => right.at - left.at).slice(0, RECENT_HITS),
    scannedAt: index.scannedAt,
    ...tokens,
    hours: hoursSpent([...index.prompts.values()].map((prompt) => prompt.at)),
    tools: knownTools([...tools]),
    ...clock,
    swarm: mostSessionsAtOnce([...index.prompts.values()]),
    rageQuits: [...last.values()].filter((prompt) => prompt.mean).length,
    badWords: new Set(bad.flatMap((hit) => hit.terms)).size,
    copies: [...typedToday.values()].reduce(
      (total, times) => total + Math.max(0, times - COPIES_PER_DAY),
      0,
    ),
    sorryAt,
    roleplay: index.roleplay ? 1 : 0,
  };
}
