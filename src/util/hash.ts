import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short, stable identifier. Same input always gives the same id, so runs can be compared. */
export function shortId(input: string, length = 12): string {
  return sha256(input).slice(0, length);
}
