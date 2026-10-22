// The prompts a person typed to Claude Code: each main session transcript
// under ~/.claude/projects, and ~/.claude/history.jsonl, which keeps what was
// typed after the transcripts are cleaned up. Subagent transcripts live one
// folder deeper and are skipped, since a person never types into them.

import path from 'node:path';

import { readAllLines } from '../files.js';
import { historyPrompt, promptFrom } from '../reputation/prompts.js';
import type { Prompt } from '../reputation/prompts.js';

import { listDir, stampOf } from './listing.js';
import type { PromptFile, PromptFileRead, UserPrompts } from './types.js';

const TITLE_CHARS = 120;

/** ~/.claude, or CLAUDE_CONFIG_DIR. Holds history.jsonl and projects/. */
export function claudeDir(home: string, env: NodeJS.ProcessEnv): string {
  return env['CLAUDE_CONFIG_DIR'] ?? path.join(home, '.claude');
}

/** Every main session transcript: <projects>/<encoded-cwd>/<session-id>.jsonl. */
async function transcripts(projectsDir: string): Promise<PromptFile[]> {
  const files: PromptFile[] = [];
  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectPath = path.join(projectsDir, project.name);
    for (const entry of await listDir(projectPath)) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')) {
        const file = path.join(projectPath, entry.name);
        const stamp = await stampOf(file);
        if (stamp !== null) {
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          files.push({ path: file, stamp, kind: 'transcript', sessionId });
        }
      }
    }
  }
  return files;
}

function stringField(line: string, key: string): string | null {
  try {
    const record: unknown = JSON.parse(line);
    const value: unknown =
      typeof record === 'object' && record !== null ? Reflect.get(record, key) : undefined;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Collapses whitespace and cuts a title to TITLE_CHARS. */
export function shortTitle(title: string): string {
  const flat = title.replaceAll(/\s+/gu, ' ');
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 3)}...` : flat;
}

/** The user's /rename title, else Claude's generated title, else the last prompt. */
export function claudeTitle(lines: readonly string[]): string | null {
  let custom: string | null = null;
  let ai: string | null = null;
  let last: string | null = null;
  for (const line of lines) {
    if (line.includes('"custom-title"')) {
      custom = stringField(line, 'customTitle') ?? custom;
    } else if (line.includes('"ai-title"')) {
      ai = stringField(line, 'aiTitle') ?? ai;
    } else if (line.includes('"last-prompt"')) {
      last = stringField(line, 'lastPrompt') ?? last;
    }
  }
  const title = custom ?? ai ?? last;
  return title === null ? null : shortTitle(title);
}

async function read(file: PromptFile): Promise<PromptFileRead> {
  const prompts: Prompt[] = [];
  const titleLines: string[] = [];
  for await (const line of readAllLines(file.path)) {
    if (file.kind === 'history' || file.sessionId === null) {
      const prompt = historyPrompt(line);
      if (prompt !== null) {
        prompts.push(prompt);
      }
    } else {
      const prompt = promptFrom(line, {
        sessionId: file.sessionId,
        fallbackAt: file.stamp?.mtimeMs ?? 0,
      });
      if (prompt !== null) {
        prompts.push(prompt);
      }
      if (
        line.includes('"custom-title"') ||
        line.includes('"ai-title"') ||
        line.includes('"last-prompt"')
      ) {
        titleLines.push(line);
      }
    }
  }
  return {
    prompts,
    title: file.kind === 'history' || file.sessionId === null ? null : claudeTitle(titleLines),
  };
}

export function claudeUserPrompts(configDir: string): UserPrompts {
  return {
    files: async (): Promise<PromptFile[]> => {
      const historyFile = path.join(configDir, 'history.jsonl');
      return [
        ...(await transcripts(path.join(configDir, 'projects'))),
        { path: historyFile, stamp: await stampOf(historyFile), kind: 'history', sessionId: null },
      ];
    },
    read,
  };
}
