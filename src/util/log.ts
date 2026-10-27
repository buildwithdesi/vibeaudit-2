/**
 * Everything the pipeline says to a human goes to stderr.
 * stdout stays clean so `--json` output can be piped into other tools.
 */
export type LogLevel = 'quiet' | 'normal' | 'verbose';

let level: LogLevel = 'normal';

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function info(message: string): void {
  if (level !== 'quiet') process.stderr.write(`${message}\n`);
}

export function debug(message: string): void {
  if (level === 'verbose') process.stderr.write(`  ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}
