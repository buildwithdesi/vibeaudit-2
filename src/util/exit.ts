import { constants } from 'node:os';

/**
 * Undo steps that must run however this process ends: a normal return, a
 * throw, process.exit(), Ctrl-C or kill. Only SIGKILL and power loss skip
 * them. The pipeline uses this to put a scanned folder's own config file
 * back and to remove its temp folders.
 */
const INTERRUPTS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const pending = new Set<() => void>();

/** Register a synchronous undo step. The returned function runs it now, at most once, and unregisters it. */
export function undoOnExit(undo: () => void): () => void {
  if (pending.size === 0) attach();
  let done = false;
  const step = () => {
    if (done) return;
    done = true;
    pending.delete(step);
    if (pending.size === 0) detach();
    undo();
  };
  pending.add(step);
  return step;
}

function attach(): void {
  process.on('exit', runPending);
  for (const signal of INTERRUPTS) process.on(signal, onInterrupt);
}

function detach(): void {
  process.off('exit', runPending);
  for (const signal of INTERRUPTS) process.off(signal, onInterrupt);
}

/** Newest first, like nested finally blocks. One failing step does not stop the rest. */
function runPending(): void {
  for (const step of [...pending].reverse()) {
    try {
      step();
    } catch {
      // Best effort on the way out.
    }
  }
}

function onInterrupt(signal: NodeJS.Signals): void {
  runPending();
  // These listeners are gone now, so the signal ends the process the way it would have without them.
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(128 + (constants.signals[signal] ?? 0));
  }
}
