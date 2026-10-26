// One rescan: read every prompt file that changed since the last scan, the
// session transcripts first and then the history files, and merge what they
// hold into the index. Each agent's observer says where its user's prompts
// are kept.

import type { PromptFile, UserPrompts } from '../sources/types.js';

import type { FileStamp, ReputationIndex } from './store.js';
import { addHistoryPrompt, addPrompt, claimSession, setTokens } from './store.js';
import { detectRoleplay } from './roleplay.js';

export interface ScanInputs {
  /** Every agent's prompt files, from the observers that keep them. */
  readonly sources: readonly UserPrompts[];
  readonly now: number;
}

export interface ScanResult {
  /** Transcripts and history files read because they changed. */
  readonly filesRead: number;
  readonly newPrompts: number;
  /** Stamps dropped for files that are gone. */
  readonly filesGone: number;
}

function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean {
  return left?.mtimeMs === right.mtimeMs && left.size === right.size;
}

interface Listed {
  readonly source: UserPrompts;
  readonly file: PromptFile;
}

async function readTranscript(index: ReputationIndex, item: Listed): Promise<number> {
  const { prompts, title, tokensByDay } = await item.source.read(item.file);
  if (item.file.sessionId !== null) {
    claimSession(index, item.file.sessionId, title);
    if (tokensByDay !== undefined) {
      setTokens(index, item.file.sessionId, tokensByDay);
    }
  }
  const added = prompts.filter((prompt) => addPrompt(index, prompt)).length;
  if (prompts.some((prompt) => detectRoleplay(prompt.text))) {
    index.roleplay = true;
  }
  return added;
}

async function readHistory(index: ReputationIndex, item: Listed): Promise<number | null> {
  const { stamp } = item.file;
  if (stamp === null || sameStamp(index.files.get(item.file.path), stamp)) {
    return null;
  }
  const { prompts } = await item.source.read(item.file);
  index.files.set(item.file.path, stamp);
  return prompts.filter((prompt) => {
    const accepted = index.sessions.get(prompt.sessionId)?.source !== 'transcript';
    const added = addHistoryPrompt(index, prompt);
    if (accepted && detectRoleplay(prompt.text)) {
      index.roleplay = true;
    }
    return added;
  }).length;
}

/** Merges new prompts into `index` in place. Running it twice on the same files adds nothing. */
export async function scanInto(index: ReputationIndex, inputs: ScanInputs): Promise<ScanResult> {
  const listed: Listed[] = [];
  for (const source of inputs.sources) {
    for (const file of await source.files()) {
      listed.push({ source, file });
    }
  }
  // A history file stays seen while it is missing, so its stamp is kept.
  const seen = new Set<string>(listed.map((item) => item.file.path));
  let filesRead = 0;
  let newPrompts = 0;
  for (const item of listed) {
    const { stamp } = item.file;
    if (item.file.kind !== 'transcript' || stamp === null) {
      continue;
    }
    if (!sameStamp(index.files.get(item.file.path), stamp)) {
      newPrompts += await readTranscript(index, item);
      index.files.set(item.file.path, stamp);
      filesRead += 1;
    }
  }
  // History goes last, so a session read from its transcript is not counted again.
  for (const item of listed) {
    const fromHistory = item.file.kind === 'history' ? await readHistory(index, item) : null;
    filesRead += fromHistory === null ? 0 : 1;
    newPrompts += fromHistory ?? 0;
  }
  // Deleted transcripts keep their prompts and sessions; only the file stamps go.
  const gone = [...index.files.keys()].filter((file) => !seen.has(file));
  for (const file of gone) {
    index.files.delete(file);
  }
  index.scannedAt = inputs.now;
  return { filesRead, newPrompts, filesGone: gone.length };
}
