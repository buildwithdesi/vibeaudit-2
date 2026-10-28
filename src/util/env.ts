import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const emptyConfigs: Record<string, string> = {};

/** Path to an empty npm config file, one per role, so neither the repo's .npmrc nor the user's applies. */
export function emptyNpmConfig(role: 'user' | 'global' = 'user'): string {
  if (!emptyConfigs[role]) {
    const dir = mkdtempSync(join(tmpdir(), 'va2-npmrc-'));
    const file = join(dir, `${role}.npmrc`);
    writeFileSync(file, '', 'utf8');
    emptyConfigs[role] = file;
  }
  return emptyConfigs[role] as string;
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
