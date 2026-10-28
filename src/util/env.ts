import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undoOnExit } from './exit.ts';

/**
 * Child processes that touch a scanned repository (the engine, npm, Docker,
 * Muse Code) get a scrubbed environment. API keys and tokens never reach a
 * process whose inputs an attacker controls. Only what a process needs to
 * start on this platform is passed through.
 */
const PASS_THROUGH = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DOCKER_HOST',
];

let emptyConfigDir: string | null = null;

/** Path to an empty npm config file, one per role, so neither the repo's .npmrc nor the user's applies. */
export function emptyNpmConfig(role: 'user' | 'global' = 'user'): string {
  if (!emptyConfigDir) {
    const dir = mkdtempSync(join(tmpdir(), 'va2-npmrc-'));
    emptyConfigDir = dir;
    // One folder per process, removed however the process ends.
    undoOnExit(() => {
      emptyConfigDir = null;
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(join(dir, 'user.npmrc'), '', 'utf8');
    writeFileSync(join(dir, 'global.npmrc'), '', 'utf8');
  }
  return join(emptyConfigDir, `${role}.npmrc`);
}

export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CI = '1';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.npm_config_userconfig = emptyNpmConfig('user');
  env.npm_config_globalconfig = emptyNpmConfig('global');
  env.npm_config_ignore_scripts = 'true';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  return { ...env, ...extra };
}
