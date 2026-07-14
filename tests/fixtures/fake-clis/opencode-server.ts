import type {
  AssistantMessage,
  OpencodeClient,
  Part,
  ServerOptions,
} from '@opencode-ai/sdk/v2';
import type {
  OpenCodeServerFactory,
  OpenCodeServerHandle,
} from '../../../src/provider-runtime/opencode/server.js';

type UnsafeKind =
  | 'tool'
  | 'native-tool'
  | 'command'
  | 'permission'
  | 'permission-session-only'
  | 'question'
  | 'mcp'
  | 'file';

interface FakeEvent {
  id: string;
  type: string;
  directory?: string;
  properties: Record<string, unknown>;
}

interface PendingPrompt {
  reject(error: Error): void;
}

class EventQueue {
  private readonly values: FakeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<FakeEvent>) => void> = [];

  constructor(private readonly onReturn?: () => Promise<void>) {}

  push(value: FakeEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  async *stream(): AsyncGenerator<FakeEvent> {
    try {
      while (true) {
        const value = this.values.shift();
        if (value) {
          yield value;
          continue;
        }
        yield await new Promise<FakeEvent>((resolve) => {
          this.waiters.push((result) => resolve(result.value));
        });
      }
    } finally {
      await this.onReturn?.();
    }
  }
}

function assistant(
  id: string,
  sessionID: string,
  parentID: string,
  structured?: unknown,
): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID,
    modelID: 'gpt-5.6',
    providerID: 'openai',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/tmp/opencode-workspace', root: '/tmp/opencode-workspace' },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...(structured === undefined ? {} : { structured }),
  };
}

function textPart(id: string, sessionID: string, messageID: string, text: string): Part {
  return { id, sessionID, messageID, type: 'text', text };
}

export interface FakeOpenCodeOptions {
  cliVersion?: string;
  modelOutput?: string;
  unsafe?: UnsafeKind;
  unsafeOtherSession?: boolean;
  waitForCreateAbort?: boolean;
  waitForAbort?: boolean;
  hangAbort?: boolean;
  iteratorCleanupDelayMs?: number;
  rejectIteratorCleanup?: boolean;
}

export class FakeOpenCode {
  readonly order: string[] = [];
  readonly creates: Array<Record<string, unknown>> = [];
  readonly prompts: Array<Record<string, unknown>> = [];
  readonly deletes: Array<Record<string, unknown>> = [];
  readonly aborts: Array<Record<string, unknown>> = [];
  readonly subscribeOptions: Array<Record<string, unknown>> = [];
  readonly createOptions: Array<Record<string, unknown>> = [];
  readonly promptOptions: Array<Record<string, unknown>> = [];
  readonly abortOptions: Array<Record<string, unknown>> = [];
  readonly commands: string[][] = [];
  options: ServerOptions | undefined;
  closeCount = 0;
  iteratorCleanupCount = 0;

  private queue: EventQueue;
  private readonly pendingPrompts = new Set<PendingPrompt>();
  private readonly cliVersion: string;
  private readonly modelOutput: string;
  private readonly unsafe: UnsafeKind | undefined;
  private readonly unsafeOtherSession: boolean;
  private readonly waitForCreateAbort: boolean;
  private readonly waitForAbort: boolean;
  private readonly hangAbort: boolean;
  private readonly iteratorCleanupDelayMs: number;
  private readonly rejectIteratorCleanup: boolean;
  private sessionSequence = 0;
  private promptSequence = 0;

  constructor(options: FakeOpenCodeOptions = {}) {
    this.cliVersion = options.cliVersion ?? '1.17.15';
    this.modelOutput = options.modelOutput ?? 'openai/gpt-5.6\nanthropic/claude-opus-4-1';
    this.unsafe = options.unsafe;
    this.unsafeOtherSession = options.unsafeOtherSession ?? false;
    this.waitForCreateAbort = options.waitForCreateAbort ?? false;
    this.waitForAbort = options.waitForAbort ?? false;
    this.hangAbort = options.hangAbort ?? false;
    this.iteratorCleanupDelayMs = options.iteratorCleanupDelayMs ?? 0;
    this.rejectIteratorCleanup = options.rejectIteratorCleanup ?? false;
    this.queue = this.newEventQueue();
  }

  readonly runCommand = async (args: string[]): Promise<string> => {
    this.commands.push(args);
    if (args.join(' ') === '--version') return this.cliVersion;
    if (args.join(' ') === 'models') return this.modelOutput;
    throw new Error(`unexpected fake OpenCode command: ${args.join(' ')}`);
  };

  readonly factory: OpenCodeServerFactory = async (options): Promise<OpenCodeServerHandle> => {
    this.options = options;
    return {
      client: this.client as unknown as OpencodeClient,
      close: () => { this.closeCount += 1; },
    };
  };

  private readonly client = {
    event: {
      subscribe: async (
        parameters: Record<string, unknown> = {},
        options: Record<string, unknown> = {},
      ) => {
        this.order.push('event.subscribe');
        this.subscribeOptions.push(options);
        this.queue = this.newEventQueue();
        return {
          stream: this.queue.stream(),
          parameters,
        };
      },
    },
    session: {
      create: async (
        parameters: Record<string, unknown> = {},
        options: Record<string, unknown> = {},
      ) => {
        this.order.push('session.create');
        this.creates.push(parameters);
        this.createOptions.push(options);
        if (this.waitForCreateAbort) await this.waitForAbortSignal(options.signal);
        this.sessionSequence += 1;
        return {
          data: {
            id: `ses_${this.sessionSequence}`,
            directory: parameters.directory,
          },
        };
      },
      prompt: async (
        parameters: Record<string, unknown>,
        options: Record<string, unknown> = {},
      ) => {
        this.order.push('session.prompt');
        this.prompts.push(parameters);
        this.promptOptions.push(options);
        this.promptSequence += 1;
        const sessionID = String(parameters.sessionID);
        const directory = String(parameters.directory);
        const userMessageID = String(parameters.messageID);
        const assistantID = `msg_${this.promptSequence}`;
        const structured = (parameters.format as { type?: string } | undefined)?.type === 'json_schema'
          ? { type: 'assistant_text', content: 'Confirmed.' }
          : undefined;
        const info = assistant(assistantID, sessionID, userMessageID, structured);
        const startedInfo: AssistantMessage = {
          ...info,
          time: { created: info.time.created },
        };

        this.queue.push({
          id: `noise-directory-${this.promptSequence}`,
          type: 'message.updated',
          directory: '/tmp/other-workspace',
          properties: { sessionID, info: startedInfo },
        });
        this.queue.push({
          id: `message-${this.promptSequence}`,
          type: 'message.updated',
          directory,
          properties: { sessionID, info: startedInfo },
        });

        if (this.waitForAbort) {
          return new Promise((_, reject) => {
            const pending = { reject };
            this.pendingPrompts.add(pending);
            const signal = options.signal instanceof AbortSignal ? options.signal : null;
            signal?.addEventListener('abort', () => {
              this.pendingPrompts.delete(pending);
              reject(new Error('fake prompt signal aborted'));
            }, { once: true });
          });
        }

        if (this.unsafe) {
          this.pushUnsafe(
            this.unsafe,
            directory,
            this.unsafeOtherSession ? 'ses_other' : sessionID,
            assistantID,
          );
        } else if (structured === undefined) {
          this.pushTextEvents(directory, sessionID, assistantID);
        }
        this.queue.push({
          id: `message-completed-${this.promptSequence}`,
          type: 'message.updated',
          directory,
          properties: { sessionID, info },
        });

        return {
          data: {
            info,
            parts: [textPart(`part-result-${this.promptSequence}`, sessionID, assistantID, 'hello')],
          },
        };
      },
      delete: async (parameters: Record<string, unknown>) => {
        this.order.push('session.delete');
        this.deletes.push(parameters);
        return { data: true };
      },
      abort: async (
        parameters: Record<string, unknown>,
        options: Record<string, unknown> = {},
      ) => {
        this.order.push('session.abort');
        this.aborts.push(parameters);
        this.abortOptions.push(options);
        if (this.hangAbort) return new Promise(() => undefined);
        for (const pending of this.pendingPrompts) pending.reject(new Error('fake prompt aborted'));
        this.pendingPrompts.clear();
        return { data: true };
      },
    },
  };

  private newEventQueue(): EventQueue {
    if (this.iteratorCleanupDelayMs === 0 && !this.rejectIteratorCleanup) {
      return new EventQueue();
    }
    return new EventQueue(async () => {
      if (this.iteratorCleanupDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.iteratorCleanupDelayMs));
      }
      this.iteratorCleanupCount += 1;
      if (this.rejectIteratorCleanup) throw new Error('fake iterator cleanup rejected');
    });
  }

  private async waitForAbortSignal(value: unknown): Promise<never> {
    if (!(value instanceof AbortSignal)) throw new Error('missing fake SDK AbortSignal');
    if (value.aborted) throw new Error('fake SDK setup aborted');
    return new Promise((_, reject) => {
      value.addEventListener('abort', () => reject(new Error('fake SDK setup aborted')), {
        once: true,
      });
    });
  }

  private pushTextEvents(directory: string, sessionID: string, messageID: string): void {
    this.queue.push({
      id: `noise-session-${this.promptSequence}`,
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID: 'ses_other',
        part: textPart('part-noise-session', 'ses_other', messageID, 'wrong'),
        delta: 'wrong-session',
      },
    });
    this.queue.push({
      id: `noise-message-${this.promptSequence}`,
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID,
        part: textPart('part-noise-message', sessionID, 'msg_other', 'wrong'),
        delta: 'wrong-message',
      },
    });
    const first = {
      id: `delta-first-${this.promptSequence}`,
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID,
        part: textPart('part-text', sessionID, messageID, 'hel'),
        delta: 'hel',
      },
    } satisfies FakeEvent;
    this.queue.push(first);
    this.queue.push(first);
    this.queue.push({
      id: `full-part-${this.promptSequence}`,
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID,
        part: textPart('part-text', sessionID, messageID, 'hello'),
      },
    });
    this.queue.push({
      id: `delta-second-${this.promptSequence}`,
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID,
        part: textPart('part-text', sessionID, messageID, 'hello'),
        delta: 'lo',
      },
    });
  }

  private pushUnsafe(
    kind: UnsafeKind,
    directory: string,
    sessionID: string,
    messageID: string,
  ): void {
    if (kind === 'tool') {
      this.queue.push({
        id: `unsafe-tool-${this.promptSequence}`,
        type: 'message.part.updated',
        directory,
        properties: {
          sessionID,
          part: {
            id: 'part-tool',
            sessionID,
            messageID,
            type: 'tool',
            callID: 'call_sensitive',
          },
        },
      });
      return;
    }
    if (kind === 'native-tool') {
      this.queue.push({
        id: `unsafe-native-tool-${this.promptSequence}`,
        type: 'session.next.tool.called',
        directory,
        properties: {
          sessionID,
          assistantMessageID: messageID,
          callID: 'call_sensitive',
        },
      });
      return;
    }
    if (kind === 'question') {
      this.queue.push({
        id: `unsafe-question-${this.promptSequence}`,
        type: 'question.v2.asked',
        directory,
        properties: { sessionID, questions: [], sensitive: 'must-not-leak' },
      });
      return;
    }
    if (kind === 'mcp' || kind === 'file') {
      this.queue.push({
        id: `unsafe-${kind}-${this.promptSequence}`,
        type: kind === 'mcp' ? 'mcp.tools.changed' : 'file.edited',
        directory,
        properties: kind === 'mcp'
          ? { server: 'must-not-leak' }
          : { file: 'must-not-leak' },
      });
      return;
    }
    this.queue.push({
      id: `unsafe-${kind}-${this.promptSequence}`,
      type: kind === 'command'
        ? 'command.executed'
        : kind === 'permission-session-only'
          ? 'permission.v2.asked'
          : 'permission.asked',
      directory,
      properties: {
        sessionID,
        ...(kind === 'command'
          ? { messageID }
          : kind === 'permission'
            ? { tool: { messageID, callID: 'call_sensitive' } }
            : {}),
        sensitive: 'must-not-leak',
      },
    });
  }
}
