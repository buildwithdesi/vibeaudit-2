import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FindingT } from '../model/finding.ts';
import { redactSecrets } from '../normalize/context.ts';
import { type ClientConfig, completeStructured } from '../reason/meta-client.ts';
import { applyEdits, type EditResult, PatchPlan, type PatchPlanT } from './edits.ts';
import { buildMuseCodePrompt, buildPatchMessages } from './prompts.ts';

const run = promisify(execFile);

export interface PatchOutcome {
  findingIds: string[];
  backend: 'api' | 'muse-code';
  plan: PatchPlanT | null;
  edits: EditResult[];
  note: string;
  usd: number;
}

/**
 * Backend one: Muse Spark through the Model API, one finding at a time,
 * answering with exact search-and-replace edits that this process applies.
 * The model never touches the disk.
 */
export async function apiPatch(
  client: ClientConfig,
  repoDir: string,
  finding: FindingT,
  rate: { input: number; cachedInput: number; output: number },
): Promise<PatchOutcome> {
  const root = resolve(repoDir);
  const abs = resolve(root, finding.file);
  if (!abs.startsWith(root + sep)) {
    return {
      findingIds: [finding.id],
      backend: 'api',
      plan: null,
      edits: [],
      note: 'file path escapes the repository',
      usd: 0,
    };
  }
  const fileContent = await readFile(abs, 'utf8');
  // The model sees the real file so its search strings match. Secrets are
  // the exception: the masked version is sent, and an edit that targets a
  // masked line fails the uniqueness check instead of leaking the secret.
  const messages = buildPatchMessages({
    finding,
    fileContent: redactSecrets(fileContent).text,
    relatedFiles: [],
  });
  const result = await completeStructured(client, {
    messages,
    schema: PatchPlan,
    schemaName: 'PatchPlan',
    reasoningEffort: 'high',
    maxOutputTokens: 4_000,
  });
  const usd =
    (Math.max(0, result.usage.promptTokens - result.usage.cachedTokens) * rate.input +
      result.usage.cachedTokens * rate.cachedInput +
      result.usage.completionTokens * rate.output) /
    1_000_000;
  const plan = result.data;
  if (plan.newDependencies.length > 0) {
    return {
      findingIds: [finding.id],
      backend: 'api',
      plan,
      edits: [],
      note: `rejected: the plan adds dependencies (${plan.newDependencies.join(', ')})`,
      usd,
    };
  }
  const edits = await applyEdits(repoDir, plan.edits);
  return { findingIds: [finding.id], backend: 'api', plan, edits, note: plan.note, usd };
}

/**
 * Backend two: Muse Code, Meta's coding agent, run headless inside the
 * sandbox clone with the prompt in a file. It edits the tree itself; the
 * loop reads the resulting diff from git.
 */
export async function museCodePatch(
  repoDir: string,
  findings: readonly FindingT[],
  options: { model: string; maxSteps: number; timeoutMs: number; museBin?: string },
): Promise<PatchOutcome> {
  const promptPath = join(repoDir, '.vibeaudit2-patch-prompt.md');
  await writeFile(promptPath, buildMuseCodePrompt(findings), 'utf8');
  const bin = options.museBin ?? 'muse';
  const args = [
    'exec',
    '--json',
    '--trust-workspace',
    '--disable-request-user-input',
    '--model',
    options.model,
    '--max-model-steps',
    String(options.maxSteps),
    '--prompt-file',
    promptPath,
  ];
  let note: string;
  try {
    const { stdout } = await run(bin, args, {
      cwd: repoDir,
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
      env: { ...process.env, MUSE_NO_AUTO_UPDATE: '1' },
    });
    note = summarizeMuseOutput(stdout);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    note = `muse exec failed: ${(e.stderr || e.message || '').trim().slice(-400)}`;
  } finally {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(promptPath);
    } catch {
      // Nothing to clean up.
    }
  }
  return {
    findingIds: findings.map((f) => f.id),
    backend: 'muse-code',
    plan: null,
    edits: [],
    note,
    usd: 0,
  };
}

export function museAvailable(): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const names = process.platform === 'win32' ? ['muse.cmd', 'muse.exe', 'muse'] : ['muse'];
  return dirs.some((dir) => names.some((name) => existsSync(join(dir, name))));
}

/** Pull the last assistant message out of the JSONL event stream, or fall back to the tail. */
function summarizeMuseOutput(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/);
  let last = '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        text?: string;
        content?: string;
        message?: string;
      };
      const text = event.text ?? event.content ?? event.message;
      if (typeof text === 'string' && text.trim()) last = text.trim();
    } catch {
      // Not JSON; ignore.
    }
  }
  return (last || lines.slice(-5).join(' ')).slice(0, 600);
}
