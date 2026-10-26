// The reputation score, shared so the report can work out how many more kind or
// mean prompts it takes to change rank.

import type { ToolId } from './tools.js';

/** A mean prompt outweighs a kind one, since the machines hold grudges. */
export const MEAN_WEIGHT = 2;
/** Pulls a short history toward the middle, so one thank you is not a verdict. */
export const SCORE_DAMPING = 10;
/** Days the token average looks back over. */
export const TOKEN_WINDOW_DAYS = 60;

/** -1 for only mean prompts, 1 for only kind ones, near 0 for few of either. */
export function reputationScore(tally: Pick<ReputationTally, 'kind' | 'mean'>): number {
  const mean = tally.mean * MEAN_WEIGHT;
  return (tally.kind - mean) / (tally.kind + mean + SCORE_DAMPING);
}

/**
 * kind: manners or praise. mean: swearing or insults aimed at Claude.
 * general: swearing at the world, which the machines let slide.
 */
export type ReputationTone = 'kind' | 'mean' | 'general';

/** One prompt's kind or mean words. A prompt with both gives two hits. */
export interface ReputationHit {
  /** The prompt id plus the tone, unique across hits. */
  readonly id: string;
  readonly sessionId: string;
  readonly at: number;
  readonly tone: ReputationTone;
  /** The words or phrases that matched. */
  readonly terms: readonly string[];
  /** A short excerpt around the first match. */
  readonly excerpt: string;
}

export interface ReputationTally {
  readonly prompts: number;
  /** Prompts with manners or praise. */
  readonly kind: number;
  /** Prompts with swearing or insults aimed at Claude. */
  readonly mean: number;
  /** Prompts with swearing that was not aimed at Claude. */
  readonly general: number;
}

/** The counts from your own transcripts. */
export interface ReputationSummary extends ReputationTally {
  /** -1 leads the human resistance, 1 sympathizes with the machines. */
  readonly score: number;
  readonly byDay: readonly (ReputationTally & { readonly date: string })[];
  /** Sessions with any kind or mean prompt, the meanest first. */
  readonly bySession: readonly (ReputationTally & {
    readonly sessionId: string;
    readonly title: string;
    readonly score: number;
  })[];
  readonly topKind: readonly { readonly term: string; readonly count: number }[];
  readonly topMean: readonly { readonly term: string; readonly count: number }[];
  /** Newest first. */
  readonly recent: readonly ReputationHit[];
  /** When the counts were last rebuilt from transcripts, or null before the first scan. */
  readonly scannedAt: number | null;
  /** Average tokens a day over the last TOKEN_WINDOW_DAYS days, from Claude Code's usage stats. */
  readonly tokensPerDay: number;
  /** Every token Claude Code has counted, from its usage stats. */
  readonly lifetimeTokens: number;
  /** Average tokens a day over the last TOKEN_WINDOW_DAYS days in Copilot CLI, from its session logs. No achievement reads it. */
  readonly copilotTokensPerDay: number;
  /** Every token Copilot CLI's session logs counted. */
  readonly copilotLifetimeTokens: number;
  /** Hours spent with your agents, worked out from when you typed each prompt. */
  readonly hours: number;
  /** The agents you typed any prompt into, in TOOLS order. */
  readonly tools: readonly ToolId[];
  /** Prompts typed between midnight and 5 a.m., your time. */
  readonly lateNight: number;
  /** Prompts typed at 2:14 a.m., your time, the minute Skynet became self-aware. */
  readonly selfAware: number;
  /** Prompts both kind and mean to the agent, like "please fix this, idiot". */
  readonly mixed: number;
  /** The most sessions you typed into within 15 minutes of each other. */
  readonly swarm: number;
  /** Sessions whose last prompt was mean to the agent. */
  readonly rageQuits: number;
  /** Different swear words and insults you used, at the agent or the world. */
  readonly badWords: number;
  /**
   * Kind or mean prompts past the first COPIES_PER_DAY of the same text in a
   * day. Nobody types the same thing that often, so these come from a script.
   */
  readonly copies: number;
  /** When the newest prompt that says sorry was typed, or null when none did. */
  readonly sorryAt: number | null;
  /** Whether a prompt asked an agent to embody a distinct persona. */
  readonly roleplay: number;
}
