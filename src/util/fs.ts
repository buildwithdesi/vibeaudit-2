import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

/** Turns any label into something safe to use inside a folder name. */
export function slug(input: string, max = 40): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'target').slice(0, max);
}
