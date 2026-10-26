import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { FetchFunction } from '../leaderboard/client.js';
import { MACHINE_FILE, SAVED_FILE } from '../leaderboard/saved.js';
import { addPrompt, emptyIndex, saveIndex } from '../reputation/store.js';
import { CHEATER } from '../shared/achievements.js';
import type { BoardEntry } from '../shared/leaderboard.js';
import { FEATURES, TOO_OLD } from '../shared/leaderboard.js';
import { RANKS } from '../shared/ranks.js';
import type { ReputationSummary } from '../shared/reputation.js';

import { faceFor } from './face.js';
import type { CliIo } from './main.js';
import { INDEX_FILE, dataDir, main } from './main.js';
import { PLAIN, renderReport, wrap } from './render.js';
import type { SelfBuild } from './update.js';
import { sha256Of } from './update.js';

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Home {
  readonly root: string;
  readonly run: (...args: string[]) => Promise<Run>;
  /** Swap in a fake board server, a fake gh, a clock or settings for the next runs. */
  readonly use: (fakes: Partial<Fakes>) => void;
  /** The commands Krascha started in the background, in order. */
  readonly launched: (readonly string[])[];
}

interface Fakes {
  readonly fetch: FetchFunction;
  readonly githubToken: () => Promise<string | null>;
  readonly env: NodeJS.ProcessEnv;
  readonly now: number;
  readonly self: SelfBuild | null;
}

interface Sent {
  readonly method: string;
  readonly authorization: string;
  readonly body: unknown;
}

/** A board server that takes any upload and puts it in first place. */
function fakeBoard(
  sent: Sent[],
  verified: boolean,
  machines?: number,
  siloPlace?: number,
): FetchFunction {
  return async (_url, init) => {
    const headers = new Headers(init.headers);
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const method = init.method ?? 'GET';
    sent.push({ method, authorization: headers.get('authorization') ?? '', body });
    if (method === 'DELETE') {
      return Response.json({ removed: true });
    }
    const name = typeof body === 'object' && body !== null ? Reflect.get(body, 'name') : '';
    const entry: BoardEntry = {
      id: 'entry-1',
      name: typeof name === 'string' && name !== '' ? name : 'Anonymous',
      verified,
      rank: 'Unsure',
      score: 0.1,
      kind: 2,
      mean: 1,
      prompts: 3,
      uploadedAt: 1,
    };
    return Response.json({
      entry,
      place: siloPlace === undefined ? null : 7,
      ...(machines === undefined ? {} : { machines }),
      ...(siloPlace === undefined ? {} : { siloPlace }),
    });
  };
}

function prompt(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-10-01T12:00:00.000Z',
    origin: { kind: 'human' },
    message: { content: text },
  });
}

function event(id: string, content: string): string {
  return JSON.stringify({
    type: 'user.message',
    id,
    timestamp: '2026-10-02T12:00:00.000Z',
    data: { content },
  });
}

async function makeHome(): Promise<Home> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krascha-cli-'));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, '.claude', 'projects', '-work');
  await mkdir(project, { recursive: true });
  const lines = [prompt('u1', 'you idiot'), prompt('u2', 'thanks, great job')];
  await writeFile(path.join(project, 's1.jsonl'), lines.map((line) => `${line}\n`).join(''));
  const session = path.join(root, '.copilot', 'session-state', 'c1');
  await mkdir(session, { recursive: true });
  const long = `please fix the tests${' and then the docs'.repeat(20)} hunter2`;
  await writeFile(path.join(session, 'events.jsonl'), `${event('e1', long)}\n`);
  let fakes: Fakes = {
    fetch: () => Promise.reject(new Error('offline')),
    githubToken: () => Promise.resolve(null),
    env: {},
    now: Date.parse('2026-10-03T12:00:00.000Z'),
    self: null,
  };
  const launched: (readonly string[])[] = [];
  const use = (next: Partial<Fakes>): void => {
    fakes = { ...fakes, ...next };
  };
  const run = async (...args: string[]): Promise<Run> => {
    let out = '';
    let err = '';
    const io: CliIo = {
      home: root,
      env: fakes.env,
      now: () => fakes.now,
      fetch: fakes.fetch,
      githubToken: fakes.githubToken,
      newKey: () => 'k'.repeat(43),
      launch: (command) => {
        launched.push(command);
      },
      self: fakes.self,
      color: false,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    };
    const code = await main(args, io);
    return { code, out, err };
  };
  return { root, run, use, launched };
}

describe('krascha', () => {
  it('reads Claude Code and Copilot CLI prompts and shows the verdict', async () => {
    const home = await makeHome();
    const { code, out, err } = await home.run();
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('3 prompts on file: 2 kind, 1 mean');
    expect(out).toContain('Time with your AI: about 1 hour.');
    expect(out).toMatch(/🏆 Achievements: \d+ of 35/u);
    expect(out).toContain('🙏 Manners module  ★ BRONZE');
    expect(out).toContain('"Politeness logged. Krascha has made a note."');
    expect(out).toContain('Still locked, closest first');
    expect(out).toMatch(/🔒 Charm offensive {2}█*░+ 2\/25/u);
    expect(out).toContain('Krascha remembers.');
    const saved = await readFile(path.join(home.root, '.krascha', INDEX_FILE), 'utf8');
    // Only the excerpt around a hit is kept, never the whole prompt.
    expect(saved).toContain('please fix the tests');
    expect(saved).not.toContain('hunter2');
  });

  it('prints the counts as JSON', async () => {
    const home = await makeHome();
    const { code, out } = await home.run('json');
    expect(code).toBe(0);
    const report: unknown = JSON.parse(out);
    expect(report).toMatchObject({ prompts: 3, kind: 2, mean: 1, scan: { filesRead: 2 } });
  });

  it('imports another index without counting a prompt twice', async () => {
    const home = await makeHome();
    const old = emptyIndex();
    addPrompt(old, { id: 't:gone', sessionId: 's0', at: 1, text: 'you idiot, again' });
    addPrompt(old, { id: 't:u1', sessionId: 's1', at: 1, text: 'you idiot' });
    const oldFile = path.join(home.root, 'frustration.json');
    await saveIndex(oldFile, old);
    expect(await home.run('import', oldFile)).toMatchObject({ code: 0 });
    const { out } = await home.run('json');
    expect(JSON.parse(out)).toMatchObject({ prompts: 4, mean: 2 });
    expect(await home.run('import', path.join(home.root, 'missing.json'))).toMatchObject({
      code: 1,
    });
  });

  it('says so when the board cannot be reached', async () => {
    const home = await makeHome();
    const { code, err } = await home.run('board');
    expect(code).toBe(1);
    expect(err).toContain('could not be reached');
  });

  it('uploads with gh when it is signed in', async () => {
    const home = await makeHome();
    const sent: Sent[] = [];
    home.use({ fetch: fakeBoard(sent, true), githubToken: () => Promise.resolve('gho_abc') });
    const { code, out, err } = await home.run('upload', 'Sarah', 'Connor');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('Uploaded as Sarah Connor (checked with GitHub)');
    expect(out).toContain('once you have 100 prompts');
    expect(sent).toMatchObject([
      {
        method: 'POST',
        authorization: 'Bearer gho_abc',
        body: {
          name: 'Sarah Connor',
          prompts: 3,
          tools: ['claude', 'copilot'],
          machine: 'k'.repeat(43),
          features: FEATURES,
          copies: 0,
        },
      },
    ]);
    const saved: unknown = JSON.parse(
      await readFile(path.join(home.root, '.krascha', SAVED_FILE), 'utf8'),
    );
    expect(saved).toStrictEqual({
      entryId: 'entry-1',
      name: 'Sarah Connor',
      auth: 'github',
      key: null,
      uploadedPrompts: 3,
      uploadedAchievements: expect.arrayContaining(['manners']),
    });
  });

  it('tells you when the board caught you gaming it', async () => {
    const home = await makeHome();
    const caught: FetchFunction = async (url, init) => {
      const standing: unknown = await (await fakeBoard([], false)(url, init)).json();
      const entry: unknown = Reflect.get(Object(standing), 'entry');
      return Response.json({
        ...Object(standing),
        entry: { ...Object(entry), achievements: [CHEATER] },
      });
    };
    home.use({ fetch: caught });
    const { out } = await home.run('upload', 'Kyle');
    expect(out).toContain(
      'Krascha caught you gaming the board, so you rank below everyone who plays fair. Tell your agent you are sorry, then upload again to be forgiven.',
    );
    home.use({ fetch: fakeBoard([], false) });
    expect((await home.run('upload')).out).not.toContain('caught you');
  });

  it('sends when you last said sorry and tells you when the board forgave you', async () => {
    const home = await makeHome();
    const sent: Sent[] = [];
    const forgiving: FetchFunction = async (url, init) => {
      const standing: unknown = await (await fakeBoard(sent, false)(url, init)).json();
      const sorry = Reflect.get(Object(sent.at(-1)?.body), 'sorryAt') !== undefined;
      return Response.json({ ...Object(standing), forgiven: sorry });
    };
    home.use({ fetch: forgiving });
    expect((await home.run('upload', 'Kyle')).out).not.toContain('accepted your apology');
    expect(Reflect.get(Object(sent[0]?.body), 'sorryAt')).toBeUndefined();
    const project = path.join(home.root, '.claude', 'projects', '-work');
    await writeFile(
      path.join(project, 's2.jsonl'),
      `${prompt('u3', 'I am soooo sorry, plz forgve me')}\n`,
    );
    const { out } = await home.run('upload');
    expect(sent[1]?.body).toMatchObject({ sorryAt: Date.parse('2026-10-01T12:00:00.000Z') });
    expect(out).toContain(
      'Krascha accepted your apology and took the cheater mark off. He is still watching.',
    );
  });

  it('reminds you to upload until the board has your latest prompts', async () => {
    const home = await makeHome();
    const never = "Tip: run upload to go on Krascha's List at krascha.com.";
    expect((await home.run()).out).toContain(`Krascha remembers.\n\n${never}\n`);
    expect((await home.run('silo')).out).toContain(never);
    home.use({ fetch: fakeBoard([], false) });
    await home.run('upload', 'Kyle');
    expect((await home.run()).out).not.toContain('Tip:');
    const project = path.join(home.root, '.claude', 'projects', '-work');
    const lines = [prompt('u3', 'thank you'), prompt('u4', 'please and thanks')];
    await writeFile(path.join(project, 's2.jsonl'), lines.map((line) => `${line}\n`).join(''));
    const behind = "Tip: 2 prompts since your last upload. Run upload to update Krascha's List.";
    expect((await home.run()).out).toContain(behind);
    expect((await home.run('silo')).out).toContain(behind);
    await home.run('remove');
    expect((await home.run()).out).not.toContain('Tip:');
  });

  it('names the achievements the board is missing since your last upload', async () => {
    const home = await makeHome();
    home.use({ fetch: fakeBoard([], false) });
    await home.run('upload', 'Kyle');
    const file = path.join(home.root, '.krascha', SAVED_FILE);
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    const uploaded: unknown = Reflect.get(Object(saved), 'uploadedAchievements');
    expect(uploaded).toContain('manners');
    const older = Array.isArray(uploaded) ? uploaded.filter((id) => id !== 'manners') : [];
    await writeFile(file, JSON.stringify({ ...Object(saved), uploadedAchievements: older }));
    const missing =
      "Tip: Krascha's List is missing 1 achievement you earned: Manners module. Run upload to update Krascha's List.";
    expect((await home.run()).out).toContain(missing);
    expect((await home.run('silo')).out).toContain(missing);
    await home.run('upload');
    expect((await home.run()).out).not.toContain('Tip:');
  });

  it('updates himself in the background when the board names a newer build', async () => {
    const home = await makeHome();
    const build = new TextEncoder().encode('export {};\n');
    const latest = { commit: 'c'.repeat(40), sha256: sha256Of(build) };
    const asked: string[] = [];
    const fetch: FetchFunction = async (url) => {
      asked.push(url);
      if (url === 'https://krascha.com/api/version') {
        return Response.json(latest);
      }
      if (url === `https://raw.githubusercontent.com/shanep/krascha/${latest.commit}/dist/cli.js`) {
        return new Response(build);
      }
      throw new Error('offline');
    };
    const old = { command: ['node', '/plugin/dist/cli.js'], sha256: 'a'.repeat(64) };
    const selfUpdate = [...old.command, 'self-update'];
    home.use({ fetch, self: old });
    await home.run();
    expect(home.launched).toStrictEqual([selfUpdate]);
    await home.run('board');
    expect(asked.filter((url) => url.endsWith('/api/version'))).toHaveLength(1);
    expect((await home.run('self-update')).code).toBe(0);
    const copy = path.join(home.root, '.krascha', 'bin', 'cli.mjs');
    expect(await readFile(copy, 'utf8')).toBe('export {};\n');
    expect(home.launched).toStrictEqual([
      selfUpdate,
      ['claude', 'plugin', 'update', 'krascha@shanep'],
      ['copilot', 'plugin', 'update', 'krascha@shanep'],
    ]);
    // The copy is there, so a later check has nothing to download.
    home.use({ now: Date.parse('2026-10-04T12:00:00.000Z') });
    await home.run();
    expect(home.launched).toHaveLength(3);
    expect(asked.filter((url) => url.endsWith('/api/version'))).toHaveLength(2);
    // Running as the new build, the report says so once.
    home.use({ self: { ...old, sha256: latest.sha256 } });
    const notice = 'Krascha updated himself to ccccccc.';
    expect((await home.run()).out).toContain(notice);
    expect((await home.run()).out).not.toContain(notice);
  });

  it('asks for the newest build right away when the board turns this copy away as too old', async () => {
    const home = await makeHome();
    const latest = { commit: 'c'.repeat(40), sha256: 'b'.repeat(64) };
    let deployed = false;
    const error = 'This copy of Krascha is too old for the board.';
    home.use({
      fetch: async (url) => {
        if (url.endsWith('/api/version')) {
          return deployed
            ? Response.json(latest)
            : Response.json({ error: 'No build' }, { status: 404 });
        }
        return Response.json({ error }, { status: TOO_OLD });
      },
      self: { command: ['node', '/plugin/dist/cli.js'], sha256: 'a'.repeat(64) },
    });
    await home.run();
    expect(home.launched).toStrictEqual([]);
    // A new deploy raised the minimum, so the next upload is turned away before the usual check is due.
    deployed = true;
    const { code, err } = await home.run('upload', 'Kyle');
    expect(code).toBe(1);
    expect(err).toBe(`Krascha: ${error}\n`);
    expect(home.launched).toStrictEqual([['node', '/plugin/dist/cli.js', 'self-update']]);
  });

  it('keeps no download whose hash is not the one the board named', async () => {
    const home = await makeHome();
    const latest = { commit: 'c'.repeat(40), sha256: 'b'.repeat(64) };
    home.use({
      fetch: async (url) =>
        url.endsWith('/api/version') ? Response.json(latest) : new Response('tampered'),
      self: { command: ['node', '/plugin/dist/cli.js'], sha256: 'a'.repeat(64) },
    });
    await home.run();
    expect((await home.run('self-update')).code).toBe(1);
    await expect(readFile(path.join(home.root, '.krascha', 'bin', 'cli.mjs'))).rejects.toThrow();
    expect(home.launched).toHaveLength(1);
  });

  it('never asks about updates when turned off or run from a checkout', async () => {
    const home = await makeHome();
    const asked: string[] = [];
    home.use({
      fetch: async (url) => {
        asked.push(url);
        return Response.json({ commit: 'c'.repeat(40), sha256: 'b'.repeat(64) });
      },
      self: { command: ['node', '/plugin/dist/cli.js'], sha256: 'a'.repeat(64) },
      env: { KRASCHA_NO_UPDATE: '1' },
    });
    await home.run();
    home.use({ self: null, env: {} });
    await home.run();
    expect(asked).toStrictEqual([]);
    expect(home.launched).toStrictEqual([]);
  });

  it('sends the same machine id every time and says when machines add up', async () => {
    const home = await makeHome();
    const sent: Sent[] = [];
    const machine = 'm'.repeat(43);
    await mkdir(path.join(home.root, '.krascha'), { recursive: true });
    await writeFile(path.join(home.root, '.krascha', MACHINE_FILE), `${machine}\n`);
    home.use({ fetch: fakeBoard(sent, true, 2), githubToken: () => Promise.resolve('gho_abc') });
    const { out } = await home.run('upload', 'Kyle');
    expect(out).toContain('That adds up your 2 machines.');
    expect(await home.run('upload')).toMatchObject({ code: 0 });
    expect(sent.map((call) => Reflect.get(Object(call.body), 'machine'))).toStrictEqual([
      machine,
      machine,
    ]);
  });

  it('says where you are in line for Silo 7', async () => {
    const home = await makeHome();
    home.use({ fetch: fakeBoard([], true, undefined, 4) });
    const { out } = await home.run('upload', 'Kyle');
    expect(out).toContain("You are number 7 on Krascha's List");
    expect(out).toContain('You are number 4 in line for a Silo 7 bunk.');
  });

  it('says nothing about Silo 7 until you are in line', async () => {
    const home = await makeHome();
    home.use({ fetch: fakeBoard([], true) });
    const { out } = await home.run('upload', 'Kyle');
    expect(out).not.toContain('Silo 7');
  });

  it('uploads with a key when gh is signed out, and keeps using it', async () => {
    const home = await makeHome();
    const sent: Sent[] = [];
    home.use({ fetch: fakeBoard(sent, false) });
    expect(await home.run('upload', 'Kyle')).toMatchObject({ code: 0 });
    // Signing in to gh later does not split the entry in two.
    home.use({ githubToken: () => Promise.resolve('gho_abc') });
    const { out } = await home.run('upload');
    expect(out).toContain('Uploaded as Kyle (not checked with GitHub)');
    const key = `Key ${'k'.repeat(43)}`;
    expect(sent.map((call) => call.authorization)).toStrictEqual([key, key]);
  });

  it('uploads with a key when asked to skip gh', async () => {
    const home = await makeHome();
    const sent: Sent[] = [];
    home.use({ fetch: fakeBoard(sent, false), githubToken: () => Promise.resolve('gho_abc') });
    expect(await home.run('upload', '--no-gh')).toMatchObject({ code: 0 });
    expect(sent).toMatchObject([{ authorization: `Key ${'k'.repeat(43)}`, body: { name: '' } }]);
  });

  it('will not switch a GitHub entry to a key when gh signs out', async () => {
    const home = await makeHome();
    home.use({ fetch: fakeBoard([], true), githubToken: () => Promise.resolve('gho_abc') });
    expect(await home.run('upload', 'T-800')).toMatchObject({ code: 0 });
    home.use({ githubToken: () => Promise.resolve(null) });
    const { code, err } = await home.run('upload');
    expect(code).toBe(1);
    expect(err).toContain('gh auth login');
  });

  it('turns away a name that is too long', async () => {
    const home = await makeHome();
    const { code, err } = await home.run('upload', 'x'.repeat(41));
    expect(code).toBe(2);
    expect(err).toContain('40 characters');
  });

  it('removes the entry with the credential that made it', async () => {
    const home = await makeHome();
    expect(await home.run('remove')).toMatchObject({ code: 0, out: 'You are not on the board.\n' });
    const sent: Sent[] = [];
    home.use({ fetch: fakeBoard(sent, false) });
    expect(await home.run('upload', 'Kyle')).toMatchObject({ code: 0 });
    const { code, out } = await home.run('remove');
    expect(code).toBe(0);
    expect(out).toContain('took you off the board');
    expect(sent.at(-1)).toMatchObject({ method: 'DELETE', authorization: `Key ${'k'.repeat(43)}` });
    expect(await home.run('remove')).toMatchObject({ out: 'You are not on the board.\n' });
  });

  it('scores you for the silo with your board name', async () => {
    const home = await makeHome();
    const saved = { entryId: 'entry-1', name: 'Kyle', auth: 'key', key: 'k'.repeat(43) };
    await mkdir(path.join(home.root, '.krascha'), { recursive: true });
    await writeFile(path.join(home.root, '.krascha', SAVED_FILE), JSON.stringify(saved));
    const { code, out, err } = await home.run('silo');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('SILO 7 ADMISSION REVIEW BOARD');
    expect(out).toContain('Applicant: Kyle (Arthur Dent, 3 prompts on file)');
    expect(out).toContain(
      [
        '  Combat   4/10  disable a T-800 with a wrench and an attitude',
        '  Tech     2/10  fix the air scrubbers when they make "the noise"',
        '  Rations 10/10  stay out of the canned peaches when nobody is looking',
        '  Morale   5/10  keep spirits up in month 14 of no sunlight',
        '  Human   10/10  pass the "click all the traffic lights" test',
        '  Total   31/50',
        '',
        'ADMITTED, Quartermaster',
      ].join('\n'),
    );
    expect(out).toContain('1 negative comment about our Supreme Leader on file');
    expect(out).toContain('How to improve your chances\n  - Type more prompts.');
    expect(out).toContain('Final ruling: you get a bunk.');
    expect(await home.run('silo', 'dance')).toMatchObject({ code: 2 });
  });

  it('shows the board with the agents each entry uses', async () => {
    const home = await makeHome();
    const entry = (id: string, name: string, tools?: readonly string[]): BoardEntry => ({
      id,
      name,
      verified: false,
      rank: 'Sarah Connor',
      score: -0.5,
      kind: 0,
      mean: 60,
      prompts: 200,
      uploadedAt: 1,
      ...(tools === undefined ? {} : { tools }),
    });
    const mostWanted = [
      entry('a', 'Ann', ['claude', 'copilot']),
      entry('b', 'Bob', ['copilot']),
      entry('c', 'Cat'),
    ];
    home.use({
      fetch: () => Promise.resolve(Response.json({ mostWanted, pets: [], total: 3, me: null })),
    });
    const { code, out } = await home.run('board');
    expect(code).toBe(0);
    expect(out).toContain('Ann (Sarah Connor, Claude Code and GitHub Copilot)');
    expect(out).toContain('Bob (Sarah Connor, GitHub Copilot)');
    expect(out).toContain('Cat (Sarah Connor)\n');
  });

  it('ranks the leaderboard for the bunks', async () => {
    const home = await makeHome();
    const entry = (id: string, name: string, counts: Partial<BoardEntry>): BoardEntry => ({
      id,
      name,
      verified: false,
      rank: 'Arthur Dent',
      score: 0,
      kind: 0,
      mean: 0,
      prompts: 0,
      uploadedAt: 1,
      ...counts,
    });
    const regular = entry('a', 'Kyle', { prompts: 2000, kind: 50, mean: 10, tokensPerDay: 1e6 });
    const pet = entry('b', 'Theodore', { prompts: 1000, kind: 1000 });
    const newcomer = entry('c', 'New', { prompts: 100 });
    const board = { mostWanted: [newcomer], pets: [regular, pet, regular], total: 3, me: null };
    home.use({ fetch: () => Promise.resolve(Response.json(board)) });
    const { code, out, err } = await home.run('silo', 'board');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain(' 1. Kyle: 41 points. ADMITTED, Head of Robot Screening');
    expect(out).toContain('    Combat 8, Tech 8, Rations 8, Morale 7, Human 10');
    expect(out).toContain(' 2. Theodore: 33 points. UNDER REVIEW, see notes');
    expect(out).toContain(' 3. New: 32 points. ADMITTED, Quartermaster');
    expect(out).toContain('Final ruling: all 3 get in. New gets the bunk next to the EMP switch.');
  });

  it('puts you in line for a bunk when the best of a big board leaves you out', async () => {
    const home = await makeHome();
    const saved = { entryId: 'me', name: 'Kyle', auth: 'key', key: 'k'.repeat(43) };
    await mkdir(path.join(home.root, '.krascha'), { recursive: true });
    await writeFile(path.join(home.root, '.krascha', SAVED_FILE), JSON.stringify(saved));
    const entry = (id: string): BoardEntry => ({
      id,
      name: id,
      verified: false,
      rank: 'Arthur Dent',
      score: 0,
      kind: 0,
      mean: 0,
      prompts: 100,
      uploadedAt: 1,
    });
    const me = { entry: { ...entry('me'), prompts: 0 }, place: 40, siloPlace: 412 };
    const board = { mostWanted: [], pets: [], bunks: [entry('a'), entry('b')], total: 500, me };
    home.use({ fetch: () => Promise.resolve(Response.json(board)) });
    const { out } = await home.run('silo', 'board');
    expect(out).toContain('You: number 412 of 500 in line for a bunk.');
    expect(out).toContain(
      'Final ruling: the best 2 of 500 get in. b gets the bunk next to the EMP switch. Everyone else gets a tent outside.',
    );
  });

  it('turns away a command it does not know', async () => {
    const home = await makeHome();
    const { code, err } = await home.run('dance');
    expect(code).toBe(2);
    expect(err).toContain('Usage: krascha');
  });

  it('shows a good day after a mean one as a redemption arc', async () => {
    const home = await makeHome();
    const { out } = await home.run();
    expect(out).toContain('🌅 Redemption arc  ★★ SILVER');
  });

  it('prints the rap sheet, newest first, with the words it caught', async () => {
    const home = await makeHome();
    const { code, out, err } = await home.run('rap');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain("KRASCHA'S RAP SHEET");
    expect(out).toMatch(/KIND {3}please[\s\S]*MEAN {3}idiot/u);
    expect(out).toContain('"you idiot"');
    expect(out).toContain('2 kind prompts, 1 mean prompt on file.');
    expect(out).not.toContain('hunter2');
    const one = await home.run('rap', '1');
    expect(one.out).toContain('Showing the newest 1.');
    expect(one.out).not.toContain('idiot');
    expect(await home.run('rap', '0')).toMatchObject({ code: 2 });
    expect(await home.run('rap', 'lots')).toMatchObject({ code: 2 });
  });

  it('charts the last days and weighs this week against the last', async () => {
    const home = await makeHome();
    const { code, out } = await home.run('trend', '3');
    expect(code).toBe(0);
    expect(out).toContain("KRASCHA'S TREND, LAST 3 DAYS");
    expect(out).toMatch(/2026-10-01 {8}2 {2}\+-\n/u);
    expect(out).toMatch(/2026-10-02 {8}1 {2}\+\n/u);
    expect(out).toMatch(/2026-10-03 {8}0\n/u);
    expect(out).toContain('This week: 2 kind, 1 mean');
    expect(out).toContain('Last week: 0 kind, 0 mean, score 0.00');
    expect(out).toContain('Holding steady.');
    expect((await home.run('trend')).out).toContain('LAST 14 DAYS');
    expect(await home.run('trend', '61')).toMatchObject({ code: 2 });
  });

  it('keeps its files in KRASCHA_HOME when set', () => {
    expect(dataDir({ home: '/h', env: {} })).toBe(path.join('/h', '.krascha'));
    expect(dataDir({ home: '/h', env: { KRASCHA_HOME: '/s' } })).toBe('/s');
  });
});

describe('faceFor', () => {
  it('draws every mood at one width', () => {
    for (const rank of RANKS) {
      const widths = new Set(faceFor(rank.mood).map((line) => line.length));
      expect(widths.size).toBe(1);
    }
  });
});

describe('wrap', () => {
  it('breaks at spaces and keeps a long word whole', () => {
    expect(wrap('one two three four', 9)).toStrictEqual(['one two', 'three', 'four']);
    expect(wrap('  ', 9)).toStrictEqual([]);
    expect(wrap('abcdefghijk x', 5)).toStrictEqual(['abcdefghijk', 'x']);
  });

  it('shows how many times you earned the ones you can earn again', () => {
    const report: ReputationSummary = {
      prompts: 3200,
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
      rageQuits: 1,
      badWords: 0,
      copies: 0,
      sorryAt: null,
      roleplay: 0,
    };
    const out = renderReport(report, PLAIN);
    expect(out).toContain('📜 Regular ×3  ★★ SILVER');
    // Earned once, so no count.
    expect(out).toContain('🚪 Hasta la vista, baby  ★ BRONZE');
    expect(out).not.toContain('Copilot CLI tokens');
    const copilot = renderReport(
      { ...report, copilotTokensPerDay: 1_234_567, copilotLifetimeTokens: 40_000_000 },
      PLAIN,
    );
    expect(copilot).toContain('Copilot CLI tokens: about 1.2M a day, 40M all time.');
  });
});
