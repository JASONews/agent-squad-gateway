const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETION_TTL_MS = 10 * 60 * 1000;

export class ReplayUnavailableError extends Error {
  constructor() {
    super('idempotency_replay_unavailable');
  }
}

interface PendingNext {
  resolve: (result: IteratorResult<string>) => void;
  reject: (error: unknown) => void;
}

class Subscription implements AsyncIterableIterator<string> {
  private readonly queued: string[];
  private readonly pending: PendingNext[] = [];
  private settled = false;
  private terminalError: unknown;

  constructor(initial: string[], private readonly detach: () => void) {
    this.queued = [...initial];
  }

  next(): Promise<IteratorResult<string>> {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
    const value = this.queued.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.settled) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<string>> {
    this.queued.length = 0;
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    return this;
  }

  push(value: string): void {
    if (this.settled) return;
    const pending = this.pending.shift();
    if (pending) pending.resolve({ done: false, value });
    else this.queued.push(value);
  }

  close(): void {
    if (this.settled) return;
    this.settled = true;
    this.detach();
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.terminalError = error;
    this.detach();
    this.queued.length = 0;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }
}

interface ReplayEntry {
  chunks: string[];
  bytes: number;
  completedAt?: number;
  subscribers: Set<Subscription>;
}

export interface ReplayBufferOptions {
  maxBytes?: number;
  completionTtlMs?: number;
  now?: () => number;
}

export class ReplayBuffer {
  private readonly entries = new Map<string, ReplayEntry>();
  private readonly maxBytes: number;
  private readonly completionTtlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: ReplayBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.completionTtlMs = options.completionTtlMs ?? DEFAULT_COMPLETION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get sizeBytes(): number {
    this.evictExpired();
    return this.totalBytes;
  }

  open(id: string): void {
    this.evictExpired();
    if (!this.entries.has(id)) {
      this.entries.set(id, { chunks: [], bytes: 0, subscribers: new Set() });
    }
    this.touch(id);
  }

  available(id: string): boolean {
    this.evictExpired();
    const available = this.entries.has(id);
    if (available) this.touch(id);
    return available;
  }

  publish(id: string, serialized: string): void {
    this.evictExpired();
    this.open(id);
    const entry = this.entries.get(id)!;
    if (entry.completedAt !== undefined) throw new Error('replay_already_completed');
    const bytes = Buffer.byteLength(serialized, 'utf8');
    entry.chunks.push(serialized);
    entry.bytes += bytes;
    this.totalBytes += bytes;
    for (const subscriber of entry.subscribers) subscriber.push(serialized);
    this.touch(id);
    this.enforceLimit();
  }

  subscribe(id: string): AsyncIterable<string> {
    this.evictExpired();
    const entry = this.entries.get(id);
    if (!entry) throw new ReplayUnavailableError();
    this.touch(id);
    let subscription!: Subscription;
    subscription = new Subscription(entry.chunks, () => entry.subscribers.delete(subscription));
    if (entry.completedAt !== undefined) subscription.close();
    else entry.subscribers.add(subscription);
    return subscription;
  }

  complete(id: string): void {
    this.evictExpired();
    const entry = this.entries.get(id);
    if (!entry) throw new ReplayUnavailableError();
    if (entry.completedAt !== undefined) return;
    entry.completedAt = this.now();
    for (const subscriber of [...entry.subscribers]) subscriber.close();
    this.touch(id);
  }

  evict(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;
    const error = new ReplayUnavailableError();
    for (const subscriber of [...entry.subscribers]) subscriber.fail(error);
  }

  private touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.completionTtlMs;
    for (const [id, entry] of this.entries) {
      if (entry.completedAt !== undefined && entry.completedAt <= cutoff) this.evict(id);
    }
  }

  private enforceLimit(): void {
    while (this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.evict(oldest);
    }
  }
}
