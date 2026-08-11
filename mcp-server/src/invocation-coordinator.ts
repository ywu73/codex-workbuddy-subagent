import { BridgeError } from "./errors.js";
import { DEFAULT_MAX_CONCURRENCY, MAX_MAX_CONCURRENCY, MIN_MAX_CONCURRENCY } from "./limits.js";

export type CoordinatedOperation = "plan" | "execute";

interface DirectoryState {
  plans: number;
  execute: boolean;
}

/**
 * A deep module that hides global concurrency and per-directory read/write
 * coordination behind one run interface. Callers never manage leases.
 */
export class InvocationCoordinator {
  private active = 0;
  private readonly directories = new Map<string, DirectoryState>();

  constructor(readonly maxConcurrency = DEFAULT_MAX_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < MIN_MAX_CONCURRENCY || maxConcurrency > MAX_MAX_CONCURRENCY) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `maxConcurrency must be an integer between ${MIN_MAX_CONCURRENCY} and ${MAX_MAX_CONCURRENCY}.`,
      );
    }
  }

  async run<T>(
    operation: CoordinatedOperation,
    cwd: string,
    taskLabel: string | undefined,
    work: () => Promise<T>,
    lockKey = cwd,
  ): Promise<T> {
    const release = this.acquire(operation, cwd, lockKey, taskLabel);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private acquire(operation: CoordinatedOperation, cwd: string, lockKey: string, taskLabel: string | undefined): () => void {
    const existing = this.directories.get(lockKey) ?? { plans: 0, execute: false };
    const directoryConflict = operation === "plan"
      ? existing.execute
      : existing.execute || existing.plans > 0;
    if (directoryConflict) {
      throw new BridgeError(
        "DIRECTORY_LOCKED",
        "Another WorkBuddy operation currently holds an incompatible lock for this directory.",
        true,
        { cwd, operation, task_label: taskLabel ?? null },
      );
    }
    if (this.active >= this.maxConcurrency) {
      throw new BridgeError(
        "BRIDGE_BUSY",
        "The WorkBuddy bridge has reached its global concurrency limit.",
        true,
        { max_concurrency: this.maxConcurrency, active: this.active, task_label: taskLabel ?? null },
      );
    }

    const state = this.directories.get(lockKey) ?? { plans: 0, execute: false };
    if (operation === "plan") state.plans += 1;
    else state.execute = true;
    this.directories.set(lockKey, state);
    this.active += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.directories.get(lockKey);
      if (current !== undefined) {
        if (operation === "plan") current.plans = Math.max(0, current.plans - 1);
        else current.execute = false;
        if (current.plans === 0 && !current.execute) this.directories.delete(lockKey);
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}
