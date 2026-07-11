export interface ComposerDraftControllerOptions {
  persistDelayMs: number;
  persist: (draft: string | null) => void;
}

export class ComposerDraftController {
  private readonly persistDelayMs: number;
  private readonly persist: (draft: string | null) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: string | null = null;
  private oversizedDomValue: string | null = null;

  constructor(options: ComposerDraftControllerOptions) {
    this.persistDelayMs = options.persistDelayMs;
    this.persist = options.persist;
  }

  get pendingSnapshot(): string | null {
    return this.snapshot;
  }

  get oversizedValue(): string | null {
    return this.oversizedDomValue;
  }

  setOversizedValue(value: string | null): void {
    this.oversizedDomValue = value;
  }

  schedule(nextDraft: string): void {
    this.snapshot = nextDraft;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const snapshot = this.snapshot;
      this.snapshot = null;
      this.persist(snapshot || null);
    }, this.persistDelayMs);
  }

  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    const snapshot = this.snapshot;
    this.snapshot = null;
    this.persist(snapshot || null);
  }

  clear(): void {
    this.snapshot = null;
    this.oversizedDomValue = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
