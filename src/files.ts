// Small file helpers: read a file that may not be there, write one without
// ever leaving half of it behind, and split a JSONL file into lines.

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

/** The file's text, or null when it does not exist. */
export async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** The file parsed as JSON, or undefined when it is missing or not JSON. */
export async function readJsonOrUndefined(file: string): Promise<unknown> {
  const text = await readOptional(file);
  if (text === null) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Writes to a temp file in the same folder, then renames it over the target,
 * so readers see the old file or the new one and never half of either.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const scratch = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(scratch, content);
    await rename(scratch, target);
  } catch (error) {
    await rm(scratch, { force: true });
    throw error;
  }
}

/** Streams complete lines of a file, leaving out a last line still being written. */
export async function* readAllLines(file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of createReadStream(file)) {
    const text = pending + decoder.write(chunk);
    let start = 0;
    let end = text.indexOf('\n', start);
    while (end !== -1) {
      yield text.slice(start, end);
      start = end + 1;
      end = text.indexOf('\n', start);
    }
    pending = text.slice(start);
  }
}
