import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { claudeUserPrompts } from '../sources/claude.js';

import type { ScanInputs } from './scan.js';
import { scanInto } from './scan.js';
import type { ReputationIndex } from './store.js';
import { emptyIndex } from './store.js';

interface Home {
  readonly inputs: ScanInputs;
  readonly historyFile: string;
  readonly transcript: (sessionId: string, lines: readonly string[]) => Promise<string>;
}

async function makeHome(): Promise<Home> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krascha-reputation-scan-'));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const projectsDir = path.join(root, 'projects');
  const project = path.join(projectsDir, '-work');
  await mkdir(project, { recursive: true });
  return {
    inputs: { sources: [claudeUserPrompts(root)], now: 500 },
    historyFile: path.join(root, 'history.jsonl'),
    transcript: async (sessionId, lines): Promise<string> => {
      const file = path.join(project, `${sessionId}.jsonl`);
      await writeFile(file, lines.map((line) => `${line}\n`).join(''));
      return file;
    },
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

function history(sessionId: string, display: string, timestamp = 1000): string {
  return JSON.stringify({ display, timestamp, sessionId, project: '/work', pastedContents: {} });
}

function ids(index: ReputationIndex): string[] {
  return [...index.prompts.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe('scanInto', () => {
  it('reads main transcripts once, with titles, and stamps the scan', async () => {
    const home = await makeHome();
    const file = await home.transcript('s1', [
      prompt('u1', 'you idiot'),
      prompt('u2', 'fine'),
      JSON.stringify({ type: 'custom-title', customTitle: 'Fix the build' }),
    ]);
    const sub = path.join(path.dirname(file), 's1', 'subagents');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'agent-a.jsonl'), `${prompt('u9', 'shit')}\n`);
    const index = emptyIndex();
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 1,
      newPrompts: 2,
      filesGone: 0,
    });
    expect(ids(index)).toStrictEqual(['t:u1', 't:u2']);
    expect([...index.hits.keys()]).toStrictEqual(['t:u1']);
    expect(index.sessions.get('s1')).toStrictEqual({
      source: 'transcript',
      title: 'Fix the build',
    });
    expect(index.scannedAt).toBe(500);
    const info = await stat(file);
    expect(index.files.get(file)).toStrictEqual({ mtimeMs: info.mtimeMs, size: info.size });
    expect(await scanInto(index, { ...home.inputs, now: 600 })).toStrictEqual({
      filesRead: 0,
      newPrompts: 0,
      filesGone: 0,
    });
    expect(index.scannedAt).toBe(600);
  });

  it('marks roleplay but not requests to adopt a functional role', async () => {
    const home = await makeHome();
    await home.transcript('s1', [
      prompt('u1', 'Pretend to be Darth Vader.'),
      prompt('u2', 'Act as a researcher and summarize this paper.'),
    ]);
    const index = emptyIndex();
    await scanInto(index, home.inputs);
    expect(index.roleplay).toBe(true);
  });

  it('finds roleplay in history when a transcript is unavailable', async () => {
    const home = await makeHome();
    await writeFile(home.historyFile, `${history('gone', 'Pretend to be a pirate.')}\n`);
    const index = emptyIndex();
    await scanInto(index, home.inputs);
    expect(index.roleplay).toBe(true);
  });

  it('rereads a file when its size or its time changes, without double counting', async () => {
    const home = await makeHome();
    const file = await home.transcript('s1', [prompt('u1', 'a')]);
    const index = emptyIndex();
    // Whole second times, so putting the old time back restores it exactly.
    await utimes(file, 1000, 1000);
    await scanInto(index, home.inputs);
    await appendFile(file, `${prompt('u2', 'b')}\n`);
    await utimes(file, 1000, 1000);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 1,
      newPrompts: 1,
      filesGone: 0,
    });
    await utimes(file, 1000, 2000);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 1,
      newPrompts: 0,
      filesGone: 0,
    });
    expect(ids(index)).toStrictEqual(['t:u1', 't:u2']);
  });

  it('keeps counts and sessions when a transcript is deleted', async () => {
    const home = await makeHome();
    const file = await home.transcript('s1', [prompt('u1', 'shit')]);
    const index = emptyIndex();
    await scanInto(index, home.inputs);
    await rm(file);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 0,
      newPrompts: 0,
      filesGone: 1,
    });
    expect(ids(index)).toStrictEqual(['t:u1']);
    expect(index.hits.size).toBe(1);
    expect(index.files.size).toBe(0);
    expect(index.sessions.get('s1')?.source).toBe('transcript');
  });

  it('counts history only for sessions without a transcript', async () => {
    const home = await makeHome();
    await home.transcript('live', [prompt('u1', 'a')]);
    await writeFile(
      home.historyFile,
      [history('live', 'a'), history('gone', 'you idiot'), history('gone', '/clear')].join('\n'),
    );
    const index = emptyIndex();
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 2,
      newPrompts: 2,
      filesGone: 0,
    });
    expect(ids(index).filter((id) => id.startsWith('h:'))).toHaveLength(1);
    expect(index.sessions.get('gone')).toStrictEqual({ source: 'history', title: null });
    expect(index.files.has(home.historyFile)).toBe(true);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 0,
      newPrompts: 0,
      filesGone: 0,
    });
  });

  it('rereads history when it grows and swaps it out when the transcript shows up', async () => {
    const home = await makeHome();
    await writeFile(home.historyFile, `${history('s2', 'shit')}\n`);
    const index = emptyIndex();
    await scanInto(index, home.inputs);
    await appendFile(home.historyFile, `${history('s2', 'damn', 2000)}\n`);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 1,
      newPrompts: 1,
      filesGone: 0,
    });
    expect(index.prompts.size).toBe(2);
    await home.transcript('s2', [prompt('u1', 'shit'), prompt('u2', 'damn')]);
    expect(await scanInto(index, home.inputs)).toStrictEqual({
      filesRead: 1,
      newPrompts: 2,
      filesGone: 0,
    });
    expect(ids(index)).toStrictEqual(['t:u1', 't:u2']);
    expect(index.hits.size).toBe(2);
    expect(index.files.has(home.historyFile)).toBe(true);
  });

  it('copes with no projects folder and no history', async () => {
    const index = emptyIndex();
    const inputs: ScanInputs = {
      sources: [claudeUserPrompts('/nope')],
      now: 1,
    };
    expect(await scanInto(index, inputs)).toStrictEqual({
      filesRead: 0,
      newPrompts: 0,
      filesGone: 0,
    });
    expect(index.scannedAt).toBe(1);
  });
});
