export type CodexRequest =
  | {
      method: 'initialize';
      id: number;
      params: {
        clientInfo: { name: string; title: string | null; version: string };
        capabilities: {
          experimentalApi: boolean;
          requestAttestation: boolean;
          optOutNotificationMethods?: string[] | null;
        } | null;
      };
    }
  | { method: 'model/list'; id: number; params: Record<string, never> }
  | { method: 'thread/start'; id: number; params: Record<string, unknown> }
  | { method: 'thread/resume'; id: number; params: Record<string, unknown> }
  | { method: 'turn/start'; id: number; params: Record<string, unknown> }
  | {
      method: 'turn/interrupt';
      id: number;
      params: { threadId: string; turnId: string };
    };

export type CodexNotification =
  | {
      method: 'item/agentMessage/delta';
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: 'item/started';
      params: { threadId: string; turnId: string; item: { type: string } };
    }
  | {
      method: 'item/completed';
      params: { threadId: string; turnId: string; item: { type: string } };
    }
  | {
      method: 'turn/completed';
      params: {
        threadId: string;
        turn: {
          id: string;
          status: 'completed' | 'interrupted' | 'failed';
          error: unknown;
        };
      };
    }
  | { method: 'error'; params: unknown };

export const CODEX_IGNORED_NOTIFICATION_METHODS = [
  'account/rateLimits/updated',
  'hook/completed',
  'hook/started',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed',
  'thread/goal/cleared',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'warning',
] as const;

const IGNORED_NOTIFICATION_METHODS = new Set<string>(CODEX_IGNORED_NOTIFICATION_METHODS);

export interface CodexThreadResult {
  thread: { id: string };
}

export interface CodexTurnResult {
  turn: { id: string };
}

export interface CodexModelListResult {
  data: Array<{
    id: string;
    displayName: string;
    supportedReasoningEfforts: string[] | null;
  }>;
}

export class CodexAdapterError extends Error {
  constructor(readonly code: 'adapter_protocol_error' | 'adapter_process_error') {
    super(code);
    this.name = 'CodexAdapterError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && record[key].length > 0;
}

export function parseCodexNotification(value: Record<string, unknown>): CodexNotification | null {
  const method = value.method;
  const params = value.params;

  if (method === 'item/agentMessage/delta' && isRecord(params)
    && hasString(params, 'threadId') && hasString(params, 'turnId')
    && hasString(params, 'itemId') && typeof params.delta === 'string') {
    return {
      method,
      params: {
        threadId: params.threadId as string,
        turnId: params.turnId as string,
        itemId: params.itemId as string,
        delta: params.delta,
      },
    };
  }

  if ((method === 'item/started' || method === 'item/completed') && isRecord(params)
    && hasString(params, 'threadId') && hasString(params, 'turnId')
    && isRecord(params.item) && hasString(params.item, 'type')) {
    return {
      method,
      params: {
        threadId: params.threadId as string,
        turnId: params.turnId as string,
        item: { type: params.item.type as string },
      },
    };
  }

  if (method === 'turn/completed' && isRecord(params)
    && hasString(params, 'threadId') && isRecord(params.turn)
    && hasString(params.turn, 'id')
    && (params.turn.status === 'completed'
      || params.turn.status === 'interrupted'
      || params.turn.status === 'failed')) {
    return {
      method,
      params: {
        threadId: params.threadId as string,
        turn: {
          id: params.turn.id as string,
          status: params.turn.status,
          error: params.turn.error,
        },
      },
    };
  }

  if (method === 'error') return { method, params };
  if (typeof method === 'string' && IGNORED_NOTIFICATION_METHODS.has(method) && isRecord(params)) {
    return null;
  }
  throw new CodexAdapterError('adapter_protocol_error');
}

export function parseThreadResult(value: unknown): CodexThreadResult {
  if (!isRecord(value) || !isRecord(value.thread) || !hasString(value.thread, 'id')) {
    throw new CodexAdapterError('adapter_protocol_error');
  }
  return { thread: { id: value.thread.id as string } };
}

export function parseTurnResult(value: unknown): CodexTurnResult {
  if (!isRecord(value) || !isRecord(value.turn) || !hasString(value.turn, 'id')) {
    throw new CodexAdapterError('adapter_protocol_error');
  }
  return { turn: { id: value.turn.id as string } };
}

export function parseModelListResult(value: unknown): CodexModelListResult {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new CodexAdapterError('adapter_protocol_error');
  }
  const data = value.data.map((model) => {
    if (!isRecord(model) || !hasString(model, 'id') || !hasString(model, 'displayName')) {
      throw new CodexAdapterError('adapter_protocol_error');
    }
    const efforts = parseReasoningEfforts(model.supportedReasoningEfforts);
    return {
      id: model.id as string,
      displayName: model.displayName as string,
      supportedReasoningEfforts: efforts,
    };
  });
  return { data };
}

function parseReasoningEfforts(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new CodexAdapterError('adapter_protocol_error');
  return value.map((effort) => {
    if (typeof effort === 'string' && effort.length > 0) return effort;
    if (isRecord(effort) && hasString(effort, 'reasoningEffort')) {
      return effort.reasoningEffort as string;
    }
    throw new CodexAdapterError('adapter_protocol_error');
  });
}
