import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FindingT } from '../model/finding.ts';
import { redactSecrets } from '../normalize/context.ts';
import { costUsd, type Rate, type Usage } from '../reason/budget.ts';
import { type ClientConfig, completeStructured, ModelApiError } from '../reason/meta-client.ts';
import { scrubbedEnv } from '../util/env.ts';
import { applyEdits, type EditResult, PatchPlan, type PatchPlanT } from './edits.ts';
import { buildMuseCodePrompt, buildPatchMessages } from './prompts.ts';

const run = promisify(execFile);
const MODEL_ID = /^[\w.:-]+$/;

export interface PatchOutcome {
  findingIds: string[];
  backend: 'api' | 'muse-code';
  plan: PatchPlanT | null;
  edits: EditResult[];
  note: string;
  usd: number;
  usage: Usage | null;
}

/**
 * Backend one: Muse Spark through the Model API, one finding at a time,
 * answering with exact search-and-replace edits that this process applies
 * to the finding's own file only. The model never touches the disk.
 */
export async function apiPatch(
  client: ClientConfig,
  repoDir: string,
  finding: FindingT,
  rate: Rate,
  siblings: readonly FindingT[] = [],
): Promise<PatchOutcome> {
  const root = resolve(repoDir);
  const abs = resolve(root, finding.file);
  const fail = (note: string): PatchOutcome => ({
    findingIds: [finding.id],
    backend: 'api',
    plan: null,
    edits: [],
    note,
    usd: 0,
    usage: null,
  });
  if (!abs.startsWith(root + sep)) return fail('file path escapes the repository');
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(abs);
  } catch {
    return fail('file not found');
  }
  if (info.isSymbolicLink() || !info.isFile()) return fail('target is not a regular file');
  if (info.size > 512 * 1024) return fail('file larger than 512 KB; patch it by hand');
  const fileContent = await readFile(abs, 'utf8');

  // The model sees the masked file. An edit that targets a masked line fails
  // the uniqueness check instead of leaking the secret.
  const messages = buildPatchMessages({
    finding,
    siblings,
    fileContent: redactSecrets(fileContent).text,
    relatedFiles: [],
  });
  let usage: Usage | null = null;
  try {
    const result = await completeStructured(client, {
      messages,
      schema: PatchPlan,
      schemaName: 'PatchPlan',
      reasoningEffort: 'high',
      maxOutputTokens: 16_000,
    });
    usage = result.usage;
    const usd = costUsd(result.usage, rate);
    const plan = result.data;
    if (plan.newDependencies.length > 0) {
      return {
        findingIds: [finding.id],
        backend: 'api',
        plan,
        edits: [],
        note: `rejected: the plan adds dependencies (${plan.newDependencies.join(', ')})`,
        usd,
        usage,
      };
    }
    const edits = await applyEdits(repoDir, plan.edits, { allowedFiles: [finding.file] });
    const ids = [finding.id, ...siblings.map((s) => s.id)];
    return { findingIds: ids, backend: 'api', plan, edits, note: plan.note, usd, usage };
  } catch (error) {
    if (error instanceof ModelApiError && error.usage) usage = error.usage;
    const usd = usage ? costUsd(usage, rate) : 0;
    return {
      findingIds: [finding.id],
      backend: 'api',
      plan: null,
      edits: [],
      note: `error: ${(error as Error).message.slice(0, 300)}`,
      usd,
      usage,
    };
  }
}

/**
 * Backend two: Muse Code, Meta's coding agent, run headless inside the
 * pipeline's copy of the repository with the prompt in a file. It edits the
 * tree itself; the loop reads the diff back from git and rejects any change
 * outside the allowed files. Contributor mode is forced off so the code is
 * never used for training. The agent gets a scrubbed environment plus the
 * one key it needs.
 */
export async function museCodePatch(
  repoDir: string,
  findings: readonly FindingT[],
  options: { model: string; maxSteps: number; timeoutMs: number; apiKey: string | null },
): Promise<PatchOutcome> {
  const ids = findings.map((f) => f.id);
  if (!MODEL_ID.test(options.model)) {
    return {
      findingIds: ids,
      backend: 'muse-code',
      plan: null,
      edits: [],
      note: `invalid model id "${options.model}"`,
      usd: 0,
      usage: null,
    };
  }
  if (/-contributor$/i.test(options.model)) {
    return {
      findingIds: ids,
      backend: 'muse-code',
      plan: null,
      edits: [],
      note: 'contributor models are not allowed: they train on the code',
      usd: 0,
      usage: null,
    };
  }
  const promptName = '.vibeaudit2-patch-prompt.md';
  await writeFile(join(repoDir, promptName), buildMuseCodePrompt(findings), 'utf8');
  // No argument contains a space or a shell character, so joining them on Windows is safe.
  const args = [
    'exec',
    '--json',
    '--trust-workspace',
    '--disable-request-user-input',
    '--contributor-mode',
    'off',
    '--model',
    options.model,
    '--max-model-steps',
    String(options.maxSteps),
    '--prompt-file',
    promptName,
  ];
  let note: string;
  try {
    const { stdout } = await run('muse', args, {
      cwd: repoDir,
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
      env: scrubbedEnv({
        MUSE_NO_AUTO_UPDATE: '1',
        MUSE_CONTRIBUTOR_MODE: '0',
        ...(options.apiKey ? { META_API_KEY: options.apiKey } : {}),
      }),
    });
    note = summarizeMuseOutput(stdout);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    note = `muse exec failed: ${(e.stderr || e.message || '').trim().slice(-400)}`;
  } finally {
    try {
      await unlink(join(repoDir, promptName));
    } catch {
      // Nothing to clean up.
    }
  }
  return {
    findingIds: ids,
    backend: 'muse-code',
    plan: null,
    edits: [],
    note,
    usd: 0,
    usage: null,
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
