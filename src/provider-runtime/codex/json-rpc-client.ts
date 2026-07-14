import type { ManagedProcess } from '../process/managed-process.js';
import { readBoundedLines } from '../process/line-reader.js';
import {
  CodexAdapterError,
  parseCodexNotification,
  type CodexNotification,
} from './protocol.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: CodexAdapterError): void;
}

interface QueueWaiter<T> {
  resolve(value: IteratorResult<T>): void;
  reject(error: CodexAdapterError): void;
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private failure: CodexAdapterError | null = null;

  constructor(private readonly onReturn: () => void) {}

  push(value: T): void {
    if (this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: CodexAdapterError): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) this.waiters.shift()!.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.values.length = 0;
    while (this.waiters.length > 0) this.waiters.shift()!.resolve({ done: true, value: undefined });
    this.onReturn();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeError(code: 'adapter_protocol_error' | 'adapter_process_error'): CodexAdapterError {
  return new CodexAdapterError(code);
}

export class CodexJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationSubscriptions = new Set<AsyncQueue<CodexNotification>>();
  private failure: CodexAdapterError | null = null;

  constructor(readonly process: ManagedProcess) {
    void this.readLoop();
    void process.exited.catch(() => this.fail(safeError('adapter_process_error')));
  }

  get closed(): boolean {
    return this.failure !== null;
  }

  subscribeNotifications(): AsyncIterableIterator<CodexNotification> {
    let subscription!: AsyncQueue<CodexNotification>;
    subscription = new AsyncQueue(() => this.notificationSubscriptions.delete(subscription));
    if (this.failure) subscription.fail(this.failure);
    else this.notificationSubscriptions.add(subscription);
    return subscription;
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    try {
      this.write({ jsonrpc: '2.0', id, method, params });
    } catch {
      this.fail(safeError('adapter_process_error'));
    }
    return response;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    try {
      this.write(params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params });
    } catch {
      const error = safeError('adapter_process_error');
      this.fail(error);
      throw error;
    }
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.process.stdin as NodeJS.WritableStream & { destroyed?: boolean };
    if (stdin.destroyed === true || !stdin.writable) {
      throw safeError('adapter_process_error');
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of readBoundedLines(this.process.stdout)) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw safeError('adapter_protocol_error');
        }
        this.accept(value);
      }
      this.fail(safeError('adapter_process_error'));
    } catch (error) {
      this.fail(error instanceof CodexAdapterError
        ? error
        : safeError('adapter_protocol_error'));
    }
  }

  private accept(value: unknown): void {
    if (!isRecord(value) || ('jsonrpc' in value && value.jsonrpc !== '2.0')) {
      throw safeError('adapter_protocol_error');
    }

    if (typeof value.method === 'string') {
      if ('id' in value) throw safeError('adapter_protocol_error');
      const notification = parseCodexNotification(value);
      if (notification) {
        for (const subscription of this.notificationSubscriptions) subscription.push(notification);
      }
      return;
    }

    if (!Number.isSafeInteger(value.id)) throw safeError('adapter_protocol_error');
    const id = value.id as number;
    const pending = this.pending.get(id);
    if (!pending) throw safeError('adapter_protocol_error');
    this.pending.delete(id);

    const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
    if (hasResult === hasError) {
      pending.reject(safeError('adapter_protocol_error'));
      throw safeError('adapter_protocol_error');
    }
    if (hasError) {
      pending.reject(safeError('adapter_protocol_error'));
      return;
    }
    pending.resolve(value.result);
  }

  private fail(error: CodexAdapterError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const subscription of this.notificationSubscriptions) subscription.fail(error);
    this.notificationSubscriptions.clear();
  }
}
