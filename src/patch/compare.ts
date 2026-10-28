import type { FindingT } from '../model/finding.ts';

/**
 * Before/after comparison for the patch loop.
 *
 * A correct patch shifts every later line in the file, so findings cannot be
 * matched by line number. Instead the unified diff of the patch gives a map
 * from old lines to new lines: unchanged lines move by the net offset of the
 * hunks above them, and lines inside a changed hunk map to that hunk's new
 * range. A finding "survives" when the after scan reports the same rule in
 * the same file at a mapped line. Anything in the after scan that no before
 * finding maps onto is new.
 */
interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}

export type LineMap = Map<string, Hunk[]>;

/** Parse `git diff -U0` output into hunks per file (new path). */
export function parseUnifiedDiff(diff: string): LineMap {
  const map: LineMap = new Map();
  let file: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      file = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      if (file && !map.has(file)) map.set(file, []);
      continue;
    }
    if (line.startsWith('--- ')) {
      const raw = line.slice(4).trim();
      if (raw !== '/dev/null') {
        const old = raw.replace(/^a\//, '');
        if (!map.has(old)) map.set(old, []);
      }
      continue;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      map.get(file)?.push({
        oldStart: Number(m[1]),
        oldLen: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLen: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
  }
  return map;
}

export interface MappedRange {
  start: number;
  end: number;
}

/** Where an old line lives after the patch. Null when the whole line was removed with nothing in its place. */
export function mapOldLine(hunks: readonly Hunk[], oldLine: number): MappedRange | null {
  let offset = 0;
  for (const h of hunks) {
    const oldEnd = h.oldStart + Math.max(h.oldLen, 1) - 1;
    if (oldLine < h.oldStart) break;
    if (h.oldLen > 0 && oldLine <= oldEnd) {
      // Inside a changed region: it now lives somewhere in the hunk's new range.
      if (h.newLen === 0) return null;
      return { start: h.newStart, end: h.newStart + h.newLen - 1 };
    }
    // A pure insertion (oldLen 0) at oldStart shifts lines at or after oldStart + 1.
    if (h.oldLen === 0 && oldLine <= h.oldStart) break;
    offset += h.newLen - h.oldLen;
  }
  return { start: oldLine + offset, end: oldLine + offset };
}

export interface Comparison {
  resolved: string[];
  remaining: string[];
  /** For each remaining id, the after-scan finding it matched. */
  remainingPairs: Array<{ beforeId: string; after: FindingT }>;
  introduced: number;
}

/**
 * A rule often reports the first matching line of a function. When a patch
 * inserts lines above it, the rule moves to a nearby line. Second-pass
 * matches accept the same rule in the same file within this many lines of
 * the mapped position, so a moved finding is "still there", never "fixed
 * and a new one appeared".
 */
export const MOVE_WINDOW = 12;

/**
 * Match every before finding onto the after scan through the line map.
 * `selected` decides which ids appear in resolved/remaining; every before
 * finding takes part in the matching so survivors are never counted as new.
 */
export function compareScans(
  before: readonly FindingT[],
  after: readonly FindingT[],
  selectedIds: ReadonlySet<string>,
  lineMap: LineMap,
): Comparison {
  const unmatched = new Set(after.map((_, i) => i));
  const resolved: string[] = [];
  const remaining: string[] = [];
  const remainingPairs: Array<{ beforeId: string; after: FindingT }> = [];
  const pending: Array<{ b: FindingT; range: MappedRange | null }> = [];

  const sameTarget = (a: FindingT, b: FindingT, file: string): boolean =>
    a.ruleId === b.ruleId && a.file.replace(/\\/g, '/') === file;

  // Pass one: exact position through the line map.
  for (const b of before) {
    const file = b.file.replace(/\\/g, '/');
    const range = b.line === null ? null : mapOldLine(lineMap.get(file) ?? [], b.line);
    let matchIndex = -1;
    for (const i of unmatched) {
      const a = after[i];
      if (!a || !sameTarget(a, b, file)) continue;
      if (
        b.line === null
          ? a.line === null
          : range && a.line !== null && a.line >= range.start && a.line <= range.end
      ) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex >= 0) {
      unmatched.delete(matchIndex);
      if (selectedIds.has(b.id)) {
        remaining.push(b.id);
        const matched = after[matchIndex];
        if (matched) remainingPairs.push({ beforeId: b.id, after: matched });
      }
    } else {
      pending.push({ b, range });
    }
  }

  // Pass two: the same rule nearby in the same file counts as moved, not new.
  for (const { b, range } of pending) {
    const file = b.file.replace(/\\/g, '/');
    let matchIndex = -1;
    if (range) {
      for (const i of unmatched) {
        const a = after[i];
        if (!a || !sameTarget(a, b, file) || a.line === null) continue;
        if (a.line >= range.start - MOVE_WINDOW && a.line <= range.end + MOVE_WINDOW) {
          matchIndex = i;
          break;
        }
      }
    }
    if (matchIndex >= 0) {
      unmatched.delete(matchIndex);
      if (selectedIds.has(b.id)) {
        remaining.push(b.id);
        const matched = after[matchIndex];
        if (matched) remainingPairs.push({ beforeId: b.id, after: matched });
      }
    } else if (selectedIds.has(b.id)) {
      resolved.push(b.id);
    }
  }
  return { resolved, remaining, remainingPairs, introduced: unmatched.size };
}
