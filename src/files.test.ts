import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { readAllLines } from './files.js';

describe('readAllLines', () => {
  it('streams lines across chunk boundaries and ignores an incomplete final line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'krascha-lines-'));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'events.jsonl');
    // The 65,555-byte file crosses the 64 KiB stream chunk boundary mid-character.
    const first = `${'a'.repeat(64 * 1024 - 1)}é`;
    await writeFile(file, `${first}\nsecond\nincomplete`);

    const lines: string[] = [];
    for await (const line of readAllLines(file)) {
      lines.push(line);
    }
    expect(lines).toStrictEqual([first, 'second']);
  });
});
