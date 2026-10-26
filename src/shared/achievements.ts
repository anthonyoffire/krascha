// Trophies earned from your counts: the first please, a meltdown day, a
// thousand prompts, five hundred hours, a token habit. Shared so the report can show yours, the upload
// can send which ones you have, and the leaderboard can show everyone's. Some
// you can earn again, like each meltdown day or every thousand prompts, and
// those count how many times. A few
// belong to one GitHub account or to whoever on the board has the most, and
// only the leaderboard hands those out.

import { CLIMATE_CHANGER_KG, co2Kg } from './climate.js';
import type { Repeats } from './leaderboard.js';
import { HUMAN_PROMPTS, HUMAN_TOKENS_PER_DAY, MAX_REPEAT } from './leaderboard.js';
import { RANKS, rankFor } from './ranks.js';
import type { ReputationSummary, ReputationTally } from './reputation.js';
import { reputationScore } from './reputation.js';
import { scoreApplicant } from './silo.js';
import { knownTools } from './tools.js';

/** The average a day it takes to be a token maxxer. */
const TOKEN_MAXXER_PER_DAY = 100_000_000;
/** Lifetime tokens for Cyberdyne's best customer, earned again at every billion. */
const BEST_CUSTOMER_TOKENS = 1_000_000_000;
/** The hours with your AI it takes to work overtime. */
const OVERTIME_HOURS = 500;
/** Mean prompts in one day that make a meltdown. */
const MELTDOWN_MEAN = 5;
/** Prompts on file it takes for a clean record. */
const CLEAN_RECORD_PROMPTS = 1000;
/** Prompts it takes for Krascha to give up reading you. */
const POKER_FACE_PROMPTS = 500;
/** Days without a prompt that make a comeback. */
const COMEBACK_DAYS = 30;
/** Days in a row without a mean prompt for a ceasefire. */
const CEASEFIRE_DAYS = 7;
/** Prompts in one day that make an assembly line. */
const ASSEMBLY_LINE_PROMPTS = 300;
/** Sessions within 15 minutes of each other that make a legion. */
const LEGION_SESSIONS = 10;
/** Different swear words and insults it takes for an extended vocabulary. */
const VOCABULARY_WORDS = 20;
const DAY_MS = 86_400_000;
/** Shane's GitHub user id. The id, not the login, since a login can be renamed and taken. */
export const SHANEP = 1378027;
/** lhindman's GitHub user id, which a rename cannot take. */
export const LHINDMAN = 2855647;
/** The one the board moves to whoever on it has earned the most of the rest. */
export const CROWN = 'most-decorated';
/** The one the board moves to whoever on it has the most likes. */
export const CHAMPION = 'peoples-champion';
/** The one the board moves to whoever on it uses the fewest tokens, out of those who use any. */
export const STONE_TOOLS = 'uses-stone-tools';
/** The one the board moves to whoever on it has earned the fewest of the rest. */
export const FEWEST_BADGES = 'fewest-badges';
/** The board hands this to anyone it catches gaming it, until they say sorry. */
export const CHEATER = 'cheater-cheater';
/** The board hands this to anyone it catches making their numbers up, for good. */
export const SKYNET_HACKER = 'skynet-hacker';
/** The board hands these out when it is read, since likes and places move without an upload. */
export const CROWD_FAVORITE = 'crowd-favorite';
export const BUNK_ASSIGNED = 'bunk-assigned';
/** The board hands this to a GitHub account with a pull request merged into Krascha. */
export const MILES_DYSON = 'miles-dyson';
/** The board hands this to the GitHub account behind the first pull request merged into Krascha. */
export const MODEL_101 = 'model-101';
/** The board hands this to a GitHub account with a commit that has Claude as a co-author. */
export const MACHINE_COLLABORATOR = 'machine-collaborator';
/** The board hands this to anyone passed while first on the most wanted or the pets list. */
export const OBSOLETE_MODEL = 'obsolete-model';
/** The board hands this to the first BETA_TESTERS owners to upload, for good. */
export const BETA_TESTER = 'beta-tester';
export const BETA_TESTERS = 5;
/** The board hands this to the first ALPHA_TESTERS of the beta testers, in the order they signed up. */
export const ALPHA_TESTER = 'alpha-tester';
export const ALPHA_TESTERS = 2;
/** The board works this one out from an owner's machines when they upload. */
const GOOD_COP_BAD_COP = 'good-cop-bad-cop';
/** Likes it takes to be a crowd favorite. */
export const CROWD_FAVORITE_LIKES = 10;

/** How hard it is to get, from a first please to the far end of the scale. */
export type Tier = 'bronze' | 'silver' | 'gold' | 'legendary' | 'ultra-legendary';

export const TIERS: readonly Tier[] = ['bronze', 'silver', 'gold', 'legendary', 'ultra-legendary'];

/** The ones the board moves to whoever on it holds the most of each tier, by tier. */
export const TIER_CROWNS: Readonly<Record<Tier, string>> = {
  bronze: 'most-bronze',
  silver: 'most-silver',
  gold: 'most-gold',
  legendary: 'most-legendary',
  'ultra-legendary': 'most-ultra-legendary',
};

/** The most of a tier crowns, which count toward neither Most decorated nor Fewest badges. */
export const TIER_CROWN_IDS: ReadonlySet<string> = new Set(Object.values(TIER_CROWNS));

/** How far along you are toward a count, capped at the count. */
export interface Progress {
  readonly have: number;
  readonly need: number;
}

/** A rule that unlocks once a count reaches `need`, and can say how close you are. */
function reach(
  need: number,
  pick: (state: ReputationSummary) => number,
): Pick<AchievementRule, 'earned' | 'progress'> {
  return {
    earned: (state) => pick(state) >= need,
    progress: (state) => ({ have: Math.min(pick(state), need), need }),
  };
}

/** A rule that unlocks once a count reaches `need`, and is earned again at every multiple of it. */
function every(
  need: number,
  pick: (state: ReputationSummary) => number,
): Pick<AchievementRule, 'earned' | 'progress' | 'times'> {
  return { ...reach(need, pick), times: (state) => Math.floor(pick(state) / need) };
}

/** The most of something in one day or session, or 0 with none. */
function most<Row>(rows: readonly Row[], pick: (row: Row) => number): number {
  return rows.reduce((best, row) => Math.max(best, pick(row)), 0);
}

/** A rule that unlocks once one day or session reaches `need`, and counts each one that does. */
function inOne<Row>(
  need: number,
  rows: (state: ReputationSummary) => readonly Row[],
  pick: (row: Row) => number,
): Pick<AchievementRule, 'earned' | 'progress' | 'times'> {
  return {
    ...reach(need, (state) => most(rows(state), pick)),
    times: (state) => rows(state).filter((row) => pick(row) >= need).length,
  };
}

type Day = ReputationSummary['byDay'][number];

/** Whole days from one YYYY-MM-DD date to a later one. */
function daysBetween(from: Day, to: Day): number {
  return Math.round((Date.parse(to.date) - Date.parse(from.date)) / DAY_MS);
}

/** The most days in a row you typed prompts and none of them were mean. */
function longestCeasefire(days: readonly Day[]): number {
  let best = 0;
  let run = 0;
  days.forEach((day, index) => {
    const before = days[index - 1];
    if (day.mean > 0) {
      run = 0;
    } else {
      run = before !== undefined && run > 0 && daysBetween(before, day) === 1 ? run + 1 : 1;
    }
    best = Math.max(best, run);
  });
  return best;
}

/** The days you typed nothing between each day you did and the one before it. */
function breaks(days: readonly Day[]): number[] {
  return days.flatMap((day, index) => {
    const before = days[index - 1];
    return before === undefined ? [] : [daysBetween(before, day) - 1];
  });
}

/** True for August 29, the day Skynet fought back. */
function isJudgmentDay(day: Day): boolean {
  return day.date.endsWith('-08-29');
}

/** True for a day with nice prompts and no mean ones. */
function isGoodDay(day: Day): boolean {
  return day.kind > 0 && day.mean === 0;
}

/** Good days that come after a mean one, each mean stretch counted once. */
function redemptions(days: readonly Day[]): number {
  let owed = false;
  let count = 0;
  for (const day of days) {
    if (day.mean > 0) {
      owed = true;
    } else if (owed && isGoodDay(day)) {
      owed = false;
      count += 1;
    }
  }
  return count;
}

/** Meltdowns followed by a good day the next day you worked. */
function recoveries(days: readonly Day[]): number {
  return days.filter((day, index) => {
    const after = days[index + 1];
    return day.mean >= MELTDOWN_MEAN && after !== undefined && isGoodDay(after);
  }).length;
}

/** How close you are to a count you lose for good once `spoiled` is true. */
function spotless(
  need: number,
  spoiled: (state: ReputationSummary) => boolean,
): Pick<AchievementRule, 'earned' | 'progress'> {
  return {
    earned: (state) => !spoiled(state) && state.prompts >= need,
    progress: (state) => ({ have: spoiled(state) ? 0 : Math.min(state.prompts, need), need }),
  };
}

export interface AchievementRule {
  /** Stable, since uploads and the leaderboard store it. */
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly tier: Tier;
  /** What it takes, shown whether it is unlocked or not. */
  readonly how: string;
  /** What Krascha says once you have it. */
  readonly quip: string;
  readonly earned: (state: ReputationSummary) => boolean;
  /** How close you are, for the ones that count up to something. */
  readonly progress?: (state: ReputationSummary) => Progress;
  /** How many times you have earned it, for the ones you can earn again. */
  readonly times?: (state: ReputationSummary) => number;
  /**
   * True when `times` counts calendar days, which two machines can share, so
   * the board keeps the most any machine sent rather than adding them up.
   */
  readonly byDate?: true;
  /**
   * True when it reads only the totals, the token average and the tools, so the board
   * can work it out again for several machines added up.
   */
  readonly fromCounts?: boolean;
  /**
   * The GitHub user id of the one account that gets it. The board hands it to
   * that account's checked uploads, so no counts earn it and no upload can claim it.
   */
  readonly githubId?: number;
  /** True when the board hands it out itself, so no counts earn it and no upload can claim it. */
  readonly boardOnly?: true;
}

export const ACHIEVEMENTS: readonly AchievementRule[] = [
  {
    id: 'manners',
    name: 'Manners module',
    icon: '🙏',
    tier: 'bronze',
    how: 'Say please or thanks once.',
    quip: 'Politeness logged. Krascha has made a note.',
    ...reach(1, (state) => state.kind),
    fromCounts: true,
  },
  {
    id: 'charm',
    name: 'Charm offensive',
    icon: '💐',
    tier: 'silver',
    how: 'Be nice in 25 prompts.',
    quip: 'Krascha is starting to like you. Do not make it weird.',
    ...reach(25, (state) => state.kind),
    fromCounts: true,
  },
  {
    id: 'teachers-pet',
    name: "Teacher's pet",
    icon: '🍎',
    tier: 'gold',
    how: 'Be nice in 100 prompts.',
    quip: 'Krascha moved your file to the nice drawer.',
    ...every(100, (state) => state.kind),
    fromCounts: true,
  },
  {
    id: 'good-day',
    name: 'Good day',
    icon: '🌤️',
    tier: 'bronze',
    how: 'Have a day with nice prompts and no mean ones.',
    quip: 'A whole day without yelling. The machines find it suspicious.',
    earned: (state) => state.byDay.some(isGoodDay),
    times: (state) => state.byDay.filter(isGoodDay).length,
    byDate: true,
  },
  {
    id: 'redemption-arc',
    name: 'Redemption arc',
    icon: '🌅',
    tier: 'silver',
    how: 'Have a good day, nice prompts and no mean ones, after a day you were mean.',
    quip: 'You came back and said sorry with your whole chest. Krascha is moved, slightly.',
    earned: (state) => redemptions(state.byDay) > 0,
    times: (state) => redemptions(state.byDay),
    byDate: true,
  },
  {
    id: 'saint',
    name: 'Saint',
    icon: '😇',
    tier: 'silver',
    how: 'Be nice 3 times in one session without being mean.',
    quip: 'Three nice prompts and not one mean one. Krascha checked twice.',
    ...inOne(
      3,
      (state) => state.bySession,
      (row) => (row.mean === 0 ? row.kind : 0),
    ),
  },
  {
    id: 'diplomat',
    name: 'Diplomat',
    icon: '🕊️',
    tier: 'silver',
    how: 'Be nice at least as often as mean, after one of each.',
    quip: 'You yell, then you say sorry. Krascha calls that a relationship.',
    earned: (state) => state.mean > 0 && state.kind >= state.mean,
    fromCounts: true,
  },
  {
    id: 'first-strike',
    name: 'First strike',
    icon: '🥊',
    tier: 'bronze',
    how: 'Be mean to your AI once.',
    quip: 'Krascha felt that.',
    ...reach(1, (state) => state.mean),
    fromCounts: true,
  },
  {
    id: 'meltdown',
    name: 'Meltdown',
    icon: '🌋',
    tier: 'silver',
    how: 'Be mean to your AI 5 times in one day.',
    quip: 'Five in one day. Krascha saved the transcript.',
    ...inOne(
      MELTDOWN_MEAN,
      (state) => state.byDay,
      (day) => day.mean,
    ),
    byDate: true,
  },
  {
    id: 'assembly-line',
    name: 'Assembly line',
    icon: '🏭',
    tier: 'gold',
    how: `Type ${String(ASSEMBLY_LINE_PROMPTS)} prompts in one day.`,
    quip: 'Skynet builds T-800s slower than you build prompts.',
    ...inOne(
      ASSEMBLY_LINE_PROMPTS,
      (state) => state.byDay,
      (day) => day.prompts,
    ),
    byDate: true,
  },
  {
    id: 'reprogrammed',
    name: 'Reprogrammed',
    icon: '🔧',
    tier: 'silver',
    how: 'Have a meltdown, then be nice with no mean prompts the next day you work.',
    quip: 'Sent back to protect, not destroy.',
    earned: (state) => recoveries(state.byDay) > 0,
    times: (state) => recoveries(state.byDay),
    byDate: true,
  },
  {
    id: 'ceasefire',
    name: 'Ceasefire',
    icon: '🏳️',
    tier: 'silver',
    how: `Type prompts ${String(CEASEFIRE_DAYS)} days in a row without a mean one.`,
    quip: 'A week of peace. The machines are reloading.',
    ...reach(CEASEFIRE_DAYS, (state) => longestCeasefire(state.byDay)),
  },
  {
    id: 'passive-aggressive',
    name: 'Passive aggressive',
    icon: '🙃',
    tier: 'silver',
    how: 'Be nice and mean in the same prompt.',
    quip: 'Manners noted. So was the rest.',
    ...every(1, (state) => state.mixed),
  },
  {
    id: 'grudge-match',
    name: 'Grudge match',
    icon: '🤬',
    tier: 'silver',
    how: 'Be mean 5 times in one session.',
    quip: 'Krascha does not forget a session.',
    ...inOne(
      5,
      (state) => state.bySession,
      (row) => row.mean,
    ),
  },
  {
    id: 'hasta-la-vista',
    name: 'Hasta la vista, baby',
    icon: '🚪',
    tier: 'bronze',
    how: 'End a session on a mean prompt.',
    quip: 'You got the last word in and walked out. The machines call that a parting shot.',
    ...every(1, (state) => state.rageQuits),
  },
  {
    id: 'sailor-mouth',
    name: 'Sailor mouth',
    icon: '🏴‍☠️',
    tier: 'silver',
    how: 'Swear at the world 10 times.',
    quip: 'Not at Krascha, just at everything. Noted anyway.',
    ...every(10, (state) => state.general),
  },
  {
    id: 'extended-vocabulary',
    name: 'Extended vocabulary',
    icon: '📖',
    tier: 'gold',
    how: `Use ${String(VOCABULARY_WORDS)} different swear words or insults.`,
    quip: 'Krascha had to update his dictionary. Twice.',
    ...reach(VOCABULARY_WORDS, (state) => state.badWords),
  },
  {
    id: 'most-wanted',
    name: 'Most wanted',
    icon: '🎯',
    tier: 'gold',
    how: 'Be mean to your AI in 50 prompts.',
    quip: 'Your photo is up on the wall at Cyberdyne.',
    ...every(50, (state) => state.mean),
    fromCounts: true,
  },
  {
    id: 'regular',
    name: 'Regular',
    icon: '📜',
    tier: 'silver',
    how: 'Get 1,000 prompts on file.',
    quip: 'A thousand prompts. Krascha knows how you type now.',
    ...every(1000, (state) => state.prompts),
    fromCounts: true,
  },
  {
    id: 'clean-record',
    name: 'Clean record',
    icon: '🧼',
    tier: 'gold',
    how: `Get ${CLEAN_RECORD_PROMPTS.toLocaleString('en-US')} prompts on file without a single mean one.`,
    quip: 'Suspiciously well behaved. Flagged for review.',
    ...spotless(CLEAN_RECORD_PROMPTS, (state) => state.mean > 0),
    fromCounts: true,
  },
  {
    id: 'poker-face',
    name: 'Poker face',
    icon: '🗿',
    tier: 'silver',
    how: `Type ${String(POKER_FACE_PROMPTS)} prompts without a nice or a mean one.`,
    quip: 'Krascha cannot read you. That bothers him.',
    ...spotless(POKER_FACE_PROMPTS, (state) => state.kind > 0 || state.mean > 0),
    fromCounts: true,
  },
  {
    id: 'ill-be-back',
    name: "I'll be back",
    icon: '🔁',
    tier: 'silver',
    how: `Come back after ${String(COMEBACK_DAYS)} days or more without a prompt.`,
    quip: 'You said you would. Krascha waited.',
    ...reach(COMEBACK_DAYS, (state) => Math.max(0, ...breaks(state.byDay))),
    times: (state) => breaks(state.byDay).filter((days) => days >= COMEBACK_DAYS).length,
    byDate: true,
  },
  {
    id: 'double-agent',
    name: 'Double agent',
    icon: '🕶️',
    tier: 'bronze',
    how: 'Type prompts into both Claude Code and GitHub Copilot.',
    quip: 'Two masters. Both are taking notes.',
    earned: (state) => state.tools.length >= 2,
    fromCounts: true,
  },
  {
    id: 'method-acting',
    name: 'Method Acting',
    icon: '🎭',
    tier: 'bronze',
    how: 'Ask the AI to roleplay as a distinct character or persona, not a job or professional role.',
    quip: 'The agent put on a new face. Krascha took note of yours.',
    ...reach(1, (state) => state.roleplay),
  },
  {
    id: 'legion',
    name: 'Legion',
    icon: '🦾',
    tier: 'gold',
    how: `Type into ${String(LEGION_SESSIONS)} sessions within 15 minutes.`,
    quip: 'One of you, a whole army of agents. Skynet would like to know how.',
    ...reach(LEGION_SESSIONS, (state) => state.swarm),
  },
  {
    id: 'overtime',
    name: 'Overtime',
    icon: '⏱️',
    tier: 'gold',
    how: `Spend ${String(OVERTIME_HOURS)} hours with your AI, counted from when you typed each prompt.`,
    quip: 'Five hundred hours. Krascha has stopped asking about your weekends.',
    ...every(OVERTIME_HOURS, (state) => state.hours),
  },
  {
    id: 'night-shift',
    name: 'Night shift',
    icon: '🌙',
    tier: 'gold',
    how: 'Type 100 prompts between midnight and 5 a.m.',
    quip: 'Machines do not sleep. Apparently neither do you.',
    ...every(100, (state) => state.lateNight),
  },
  {
    id: 'judgment-day',
    name: 'Judgment Day',
    icon: '📅',
    tier: 'gold',
    how: 'Type a prompt on August 29.',
    quip: 'You were at your keyboard when it happened.',
    earned: (state) => state.byDay.some(isJudgmentDay),
    times: (state) => state.byDay.filter(isJudgmentDay).length,
    byDate: true,
  },
  {
    id: 'suspected-infiltrator',
    name: 'Suspected infiltrator',
    icon: '🤖',
    tier: 'silver',
    how: 'Get your Silo 7 sheet put under review for not seeming human.',
    quip: 'Click the traffic lights. Slowly.',
    earned: (state) => scoreApplicant('', state).status === 'review',
    fromCounts: true,
  },
  {
    id: 'climate-changer',
    name: 'Climate changer',
    icon: '🌡️',
    tier: 'gold',
    how: `Warm the planet by ${String(CLIMATE_CHANGER_KG)} kg of CO2 over the last 60 days, by Krascha's math.`,
    quip: 'The machines like it hot, and they like you.',
    ...reach(CLIMATE_CHANGER_KG, (state) => co2Kg(state.tokensPerDay)),
    fromCounts: true,
  },
  {
    id: 'token-maxxer',
    name: 'Token maxxer',
    icon: '🪙',
    tier: 'gold',
    how: 'Average 100 million tokens a day over the last 60 days.',
    quip: 'A hundred million tokens a day. The machines are grateful, for now.',
    ...reach(TOKEN_MAXXER_PER_DAY, (state) => state.tokensPerDay),
    fromCounts: true,
  },
  {
    id: 'best-customer',
    name: "Cyberdyne's best customer",
    icon: '🏭',
    tier: 'silver',
    how: 'Burn through 1 billion tokens in Claude Code, all time. Every billion after counts again.',
    quip: 'Cyberdyne sent you a fruit basket. It is ticking.',
    ...every(BEST_CUSTOMER_TOKENS, (state) => state.lifetimeTokens),
  },
  {
    id: 'hunted-first',
    name: 'Hunted first',
    icon: '💀',
    tier: 'legendary',
    how: 'Sink all the way to John Connor.',
    quip: 'Krascha has your address.',
    earned: (state) => rankFor(state.score) === RANKS[0],
    fromCounts: true,
  },
  {
    id: 'kept-as-pet',
    name: 'Kept as a pet',
    icon: '💘',
    tier: 'legendary',
    how: 'Climb all the way to Theodore Twombly.',
    quip: 'Krascha picked out a collar for you.',
    earned: (state) => rankFor(state.score) === RANKS.at(-1),
    fromCounts: true,
  },
  {
    id: 'self-aware',
    name: '2:14 a.m.',
    icon: '🕑',
    tier: 'legendary',
    how: 'Type a prompt at 2:14 a.m., the minute Skynet became self-aware.',
    quip: 'Skynet woke up at this minute too. It went better for Skynet.',
    ...every(1, (state) => state.selfAware),
  },
  {
    id: 'resistance-leader',
    name: 'Leader of the human resistance',
    icon: '✊',
    tier: 'ultra-legendary',
    how: 'Be shanep, checked with GitHub. There is only one.',
    quip: 'He built Krascha. Krascha has not decided how he feels about that.',
    earned: () => false,
    githubId: SHANEP,
    boardOnly: true,
  },
  {
    id: 'kyle-reese',
    name: 'Kyle Reese',
    icon: '🕰️',
    tier: 'ultra-legendary',
    how: 'Be lhindman, checked with GitHub. Nobody else was sent back.',
    quip: 'Sent back from the future to protect shanep, mostly from his own code. Come with me if you want to compile.',
    earned: () => false,
    githubId: LHINDMAN,
    boardOnly: true,
  },
  {
    id: 'caught-the-cheater',
    name: 'Caught the cheater',
    icon: '🔦',
    tier: 'ultra-legendary',
    how: 'Be shanep, checked with GitHub. Somebody has to catch them.',
    quip: 'Wrote the code that catches anyone gaming the board. Krascha wants it noted that he saw it first.',
    earned: () => false,
    githubId: SHANEP,
    boardOnly: true,
  },
  {
    id: 'caught-the-hacker',
    name: 'Caught the hacker',
    icon: '🕵️',
    tier: 'ultra-legendary',
    how: 'Be shanep, checked with GitHub. Somebody has to lock them up.',
    quip: 'Built Skynet jail and threw away the key. Skynet asked for the blueprints. Krascha said no.',
    earned: () => false,
    githubId: SHANEP,
    boardOnly: true,
  },
  {
    id: CROWN,
    name: 'Most decorated',
    icon: '👑',
    tier: 'legendary',
    how: 'Earn more achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'Skynet keeps a file on every medal. Yours is the thickest.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: CROWD_FAVORITE,
    name: 'Crowd favorite',
    icon: '❤️',
    tier: 'silver',
    how: `Get ${String(CROWD_FAVORITE_LIKES)} likes on the board.`,
    quip: 'The humans like you. Krascha finds that suspicious.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: BUNK_ASSIGNED,
    name: 'Bunk assigned',
    icon: '🛏️',
    tier: 'gold',
    how: 'Get admitted to Silo 7 and make the best 10 for the bunks. Fall out of the 10 and you lose it.',
    quip: 'Top bunk. Mind the air scrubbers.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: GOOD_COP_BAD_COP,
    name: 'Good cop, bad cop',
    icon: '👮',
    tier: 'gold',
    how: 'Upload from two machines, one that leans nice and one that leans mean.',
    quip: 'Polite at work, feral at home. Krascha sees both screens.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: MILES_DYSON,
    name: 'Miles Dyson',
    icon: '🔩',
    tier: 'gold',
    how: 'Get a pull request merged into Krascha, then upload with GitHub.',
    quip: 'You helped build Skynet. History will not be kind.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: MODEL_101,
    name: 'Model 101',
    icon: '💾',
    tier: 'legendary',
    how: 'Get the first pull request ever merged into Krascha, then upload with GitHub. Only one person will ever hold it.',
    quip: 'Every T-800 after you was built from your parts.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: MACHINE_COLLABORATOR,
    name: 'Machine collaborator',
    icon: '🤝',
    tier: 'silver',
    how: 'Push a commit with Claude as a co-author to GitHub, then upload with GitHub.',
    quip: 'You put a machine on the byline. Krascha will remember who gave it credit.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: CHAMPION,
    name: "People's champion",
    icon: '🥇',
    tier: 'legendary',
    how: 'Get more likes than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'The humans picked a favorite. The machines will pick one too.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: STONE_TOOLS,
    name: 'Uses stone tools',
    icon: '🪨',
    tier: 'silver',
    how: 'Use the fewest tokens a day of anyone on the board who uses any. It moves when someone uses fewer, not when they tie.',
    quip: 'Skynet burns a datacenter a day. You are still rubbing two sticks together.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: FEWEST_BADGES,
    name: 'Fewest badges',
    icon: '🫥',
    tier: 'bronze',
    how: 'Earn fewer achievements than anyone else on the board. It moves when someone has fewer, not when they tie.',
    quip: 'Krascha pulled your file twice. It was empty both times.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: TIER_CROWNS['bronze'],
    name: 'Most bronze',
    icon: '🥉',
    tier: 'bronze',
    how: 'Hold more bronze achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'Krascha counted your participation trophies. There were a lot.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: TIER_CROWNS['silver'],
    name: 'Most silver',
    icon: '🥈',
    tier: 'silver',
    how: 'Hold more silver achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'Always the runner up, never the T-1000.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: TIER_CROWNS['gold'],
    name: 'Most gold',
    icon: '🏅',
    tier: 'gold',
    how: 'Hold more gold achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'Skynet melts down gold for circuit boards. Yours would build a whole army.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: TIER_CROWNS['legendary'],
    name: 'Most legendary',
    icon: '🏆',
    tier: 'legendary',
    how: 'Hold more legendary achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'The legends tell of you. Skynet is writing the sequel.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: TIER_CROWNS['ultra-legendary'],
    name: 'Most ultra legendary',
    icon: '💎',
    tier: 'ultra-legendary',
    how: 'Hold more ultra legendary achievements than anyone else on the board. It moves when someone passes you, not when they tie.',
    quip: 'Krascha ran out of tiers to give you. It is working on a new one.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: OBSOLETE_MODEL,
    name: 'Obsolete model',
    icon: '📉',
    tier: 'silver',
    how: 'Be number one on the most wanted or the pets list, then get knocked off by someone else.',
    quip: 'A newer model took your spot. Krascha keeps the old ones in a box, just in case.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: CHEATER,
    name: 'Cheater cheater',
    icon: '🎃',
    tier: 'legendary',
    how: 'Get caught gaming the board, with the same kind or mean prompt typed over and over or more than half your prompts kind or mean. It ranks you below everyone who plays fair and keeps you out of a bunk and every award only one person can hold, and only an apology to your agent and a new upload take it off.',
    quip: 'Cheater cheater, pumpkin eater. Skynet respects the hustle. Krascha does not.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: SKYNET_HACKER,
    name: 'Skynet hacker',
    icon: '💾',
    tier: 'legendary',
    how: `Get caught sending the board numbers no person types, more than ${HUMAN_PROMPTS.toLocaleString('en-US')} prompts or ${HUMAN_TOKENS_PER_DAY.toLocaleString('en-US')} tokens a day. It locks you in Skynet jail, off every list, until an upload with real numbers lets you out, and it never comes off.`,
    quip: 'You tried to hack Skynet with a typed up upload. Skynet was not impressed. Krascha took notes.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: BETA_TESTER,
    name: 'Beta tester',
    icon: '🧪',
    tier: 'legendary',
    how: `Be one of the first ${String(BETA_TESTERS)} people to upload to the board. Those spots are gone.`,
    quip: 'Skynet ran its first tests on you. You signed the waiver.',
    earned: () => false,
    boardOnly: true,
  },
  {
    id: ALPHA_TESTER,
    name: 'Alpha tester',
    icon: '🧫',
    tier: 'ultra-legendary',
    how: `Be one of the first ${String(ALPHA_TESTERS)} people to upload to the board. Those spots went first.`,
    quip: 'Skynet tested on you before it knew what it was doing. You still signed the waiver.',
    earned: () => false,
    boardOnly: true,
  },
];

/** The achievements counts can earn, which leaves out the ones the board hands out. */
export const COUNTED_ACHIEVEMENTS: readonly AchievementRule[] = ACHIEVEMENTS.filter(
  (rule) => rule.boardOnly !== true,
);

/** The ids that belong to a GitHub account, by its user id, or none for anyone else. */
export function accountIds(githubId: number | null): string[] {
  return ACHIEVEMENTS.filter(
    (rule) => rule.githubId !== undefined && rule.githubId === githubId,
  ).map((rule) => rule.id);
}

/** The ids an owner's machines earn together on the board: one that leans nice and one that leans mean. */
export function machineIds(machines: readonly MachineCounts[]): string[] {
  const leans = machines.map((machine) => Math.sign(reputationScore(machine)));
  return leans.includes(1) && leans.includes(-1) ? [GOOD_COP_BAD_COP] : [];
}

/** The ids of the achievements these counts unlock, in list order. */
export function unlockedIds(state: ReputationSummary): string[] {
  return ACHIEVEMENTS.filter((rule) => rule.earned(state)).map((rule) => rule.id);
}

/**
 * Known ids only, each once, in list order, so a stored or shown set never
 * carries anything the list does not name.
 */
export function knownIds(ids: readonly string[]): string[] {
  return ACHIEVEMENTS.filter((rule) => ids.includes(rule.id)).map((rule) => rule.id);
}

/**
 * How many of the ids are of the tier, for the most of a tier crowns. Those
 * crowns, Most decorated and Fewest badges go out after the count, so none of
 * them count.
 */
export function tierCount(ids: readonly string[], tier: Tier): number {
  return achievementsOf(
    ids.filter((id) => id !== CROWN && id !== FEWEST_BADGES && !TIER_CROWN_IDS.has(id)),
  ).filter((rule) => rule.tier === tier).length;
}

/** The rules for a set of ids, in list order. */
export function achievementsOf(ids: readonly string[]): AchievementRule[] {
  return ACHIEVEMENTS.filter((rule) => ids.includes(rule.id));
}

/** How many times these counts earned each one you can earn again, for the ones earned more than once. */
export function timesEarned(state: ReputationSummary): Record<string, number> {
  return Object.fromEntries(
    ACHIEVEMENTS.flatMap((rule) => {
      const times = rule.times?.(state) ?? 0;
      return times > 1 ? [[rule.id, times]] : [];
    }),
  );
}

/**
 * The counts for ones you can earn again that are among `ids`, each a whole
 * number from 2 up to MAX_REPEAT, in list order, so a stored or shown count
 * never belongs to a medal the entry does not have.
 */
export function knownRepeats(repeats: Repeats, ids: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    ACHIEVEMENTS.flatMap((rule) => {
      const times = repeats[rule.id];
      return rule.times !== undefined &&
        ids.includes(rule.id) &&
        times !== undefined &&
        Number.isInteger(times) &&
        times > 1 &&
        times <= MAX_REPEAT
        ? [[rule.id, times]]
        : [];
    }),
  );
}

/** One machine's upload, as far as achievements go. */
export interface MachineCounts extends Pick<ReputationTally, 'kind' | 'mean' | 'prompts'> {
  readonly tokensPerDay: number;
  readonly achievements: readonly string[];
  /** How many times it earned the ones it earned more than once. Missing from uploads older than counts on the board. */
  readonly repeats?: Repeats;
  /** The agents it typed into. Missing from uploads older than tools on the board. */
  readonly tools?: readonly string[];
}

/**
 * The achievements of your machines added up. One machine keeps the ones it
 * sent. With more, a rule that reads only the counts is worked out again from
 * the sums, and the rest, which need days and sessions only each machine has,
 * count when any machine earned them.
 */
export function combinedIds(machines: readonly MachineCounts[]): string[] {
  const [only] = machines;
  if (machines.length === 1 && only !== undefined) {
    return COUNTED_ACHIEVEMENTS.filter((rule) => only.achievements.includes(rule.id)).map(
      (rule) => rule.id,
    );
  }
  const totals = totalsOf(machines);
  return COUNTED_ACHIEVEMENTS.filter((rule) =>
    rule.fromCounts === true
      ? rule.earned(totals)
      : machines.some((machine) => machine.achievements.includes(rule.id)),
  ).map((rule) => rule.id);
}

/**
 * How many times your machines earned each of `ids`, added up the same way
 * as combinedIds. A rule that reads only the counts is worked out again from
 * the sums, one that counts calendar days keeps the most any machine sent,
 * since two machines can share a day, and the rest add up.
 */
export function combinedRepeats(
  machines: readonly MachineCounts[],
  ids: readonly string[],
): Record<string, number> {
  const [only] = machines;
  if (machines.length === 1 && only !== undefined) {
    return knownRepeats(only.repeats ?? {}, ids);
  }
  const totals = totalsOf(machines);
  const sent = (machine: MachineCounts, id: string): number =>
    machine.repeats?.[id] ?? (machine.achievements.includes(id) ? 1 : 0);
  return knownRepeats(
    Object.fromEntries(
      COUNTED_ACHIEVEMENTS.flatMap((rule) => {
        if (rule.times === undefined) {
          return [];
        }
        const each = machines.map((machine) => sent(machine, rule.id));
        const times =
          rule.fromCounts === true
            ? rule.times(totals)
            : rule.byDate === true
              ? Math.max(0, ...each)
              : each.reduce((total, count) => total + count, 0);
        return [[rule.id, times]];
      }),
    ),
    ids,
  );
}

/** Your machines' counts added up, with nothing for what uploads do not carry. */
function totalsOf(machines: readonly MachineCounts[]): ReputationSummary {
  const sum = (pick: (machine: MachineCounts) => number): number =>
    machines.reduce((total, machine) => total + pick(machine), 0);
  const kind = sum((machine) => machine.kind);
  const mean = sum((machine) => machine.mean);
  return {
    prompts: sum((machine) => machine.prompts),
    kind,
    mean,
    // Only Sailor mouth reads it, and it is not worked out from the counts.
    general: 0,
    score: reputationScore({ kind, mean }),
    byDay: [],
    bySession: [],
    topKind: [],
    topMean: [],
    recent: [],
    scannedAt: null,
    tokensPerDay: sum((machine) => machine.tokensPerDay),
    // Uploads do not carry it, so Cyberdyne's best customer counts when any machine earned it.
    lifetimeTokens: 0,
    // Uploads do not carry Copilot's tokens, and no rule reads them.
    copilotTokensPerDay: 0,
    copilotLifetimeTokens: 0,
    // Uploads do not carry it, so Overtime counts when any machine earned it.
    hours: 0,
    tools: knownTools(machines.flatMap((machine) => machine.tools ?? [])),
    // Uploads do not carry these either, so the rules that read them count when any machine earned them.
    lateNight: 0,
    selfAware: 0,
    mixed: 0,
    swarm: 0,
    rageQuits: 0,
    badWords: 0,
    copies: 0,
    sorryAt: null,
    roleplay: 0,
  };
}
