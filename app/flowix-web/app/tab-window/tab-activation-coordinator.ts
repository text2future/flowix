export type ActivationTask = (
  tabId: string,
  isLatest: () => boolean,
) => Promise<boolean>;

interface PendingActivation {
  tabId: string;
  task: ActivationTask;
  resolve: (activated: boolean) => void;
}

/**
 * Single-worker, latest-wins activation queue.
 *
 * Work already committing a document is allowed to finish, but queued
 * intermediate selections are replaced by the newest user intent. The task
 * can also check `isLatest` after an async prepare step and avoid committing a
 * target that became stale while its backend snapshot was loading.
 */
export class TabActivationCoordinator {
  private pending: PendingActivation | null = null;
  private latestTabId: string | null = null;
  private drainPromise: Promise<boolean> | null = null;

  request(tabId: string, task: ActivationTask): Promise<boolean> {
    this.latestTabId = tabId;
    if (this.pending) this.pending.resolve(false);

    const result = new Promise<boolean>((resolve) => {
      this.pending = { tabId, task, resolve };
    });
    if (!this.drainPromise) {
      // Start in a microtask so multiple selections from the same event turn
      // collapse before any backend work begins.
      this.drainPromise = Promise.resolve().then(() => this.drain());
    }
    return result;
  }

  waitForIdle(): Promise<boolean> {
    return this.drainPromise ?? Promise.resolve(true);
  }

  private async drain(): Promise<boolean> {
    let lastResult = true;
    try {
      while (this.pending) {
        const request = this.pending;
        this.pending = null;
        try {
          lastResult = await request.task(
            request.tabId,
            () => this.latestTabId === request.tabId,
          );
        } catch {
          lastResult = false;
        }
        request.resolve(lastResult);
      }
      return lastResult;
    } finally {
      this.drainPromise = null;
      // A request cannot normally interleave with this synchronous finally,
      // but retaining this guard makes the coordinator safe if its internals
      // later gain an awaited cleanup phase.
      if (this.pending) {
        this.drainPromise = Promise.resolve().then(() => this.drain());
      }
    }
  }
}
