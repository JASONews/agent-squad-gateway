export type ClientStatus = 'active' | 'disabled';
export interface ClientRecord { id: string; name: string; status: ClientStatus; createdAt: string; updatedAt: string }
export interface AuthenticatedCredential { credentialId: string; clientId: string; prefix: string }
export interface CreatedCredential { id: string; clientId: string; prefix: string; apiKey: string }
export type IsolationLevel = 'strict' | 'best_effort';
export type StreamingMode = 'native' | 'none';
export type ToolBridge = 'structured_output' | 'none';

export interface TargetCapabilities {
  isolationLevel: IsolationLevel;
  streamingMode: StreamingMode;
  toolBridge: ToolBridge;
  resume: boolean;
  cancellation: boolean;
  modelSelection: boolean;
  effortSelection: boolean;
  details?: string[];
}

export interface InvocationTarget {
  id: string;
  aliases: string[];
  cli: string;
  nativeModel: string;
  reasoningEffort: string | null;
  enabled: boolean;
  isolationLevel: IsolationLevel;
  streamingMode: StreamingMode;
  toolBridge: ToolBridge;
  maxConcurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
  runTimeoutMs: number | null;
  fixedWorkspace: string | null;
  capabilityVersion: string | null;
  capabilityVerifiedAt: string | null;
  capabilities: TargetCapabilities | null;
  capabilityError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTargetInput {
  id: string;
  aliases?: string[];
  cli: string;
  nativeModel: string;
  reasoningEffort?: string | null;
  isolationLevel?: IsolationLevel;
  streamingMode?: StreamingMode;
  toolBridge?: ToolBridge;
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  runTimeoutMs?: number | null;
  fixedWorkspace?: string | null;
  acknowledgeFixedWorkspaceDowngrade?: boolean;
}

export interface UpdateTargetInput {
  aliases?: string[];
  cli?: string;
  nativeModel?: string;
  reasoningEffort?: string | null;
  enabled?: boolean;
  isolationLevel?: IsolationLevel;
  streamingMode?: StreamingMode;
  toolBridge?: ToolBridge;
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  runTimeoutMs?: number | null;
  fixedWorkspace?: string | null;
  acknowledgeFixedWorkspaceDowngrade?: boolean;
  enabledBestEffort?: boolean;
}

export interface ExtensionRecord {
  id: string;
  version: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GrantRecord {
  clientId: string;
  extensionId: string;
  targetId: string;
  createdAt: string;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface CreateRunInput {
  clientId?: string | null;
  extensionId: string;
  targetId: string;
  endpoint: string;
  responseId?: string | null;
}

export interface RunRecord {
  id: string;
  clientId: string | null;
  extensionId: string;
  targetId: string;
  endpoint: string;
  status: RunStatus;
  responseId: string | null;
  nativeSessionId: string | null;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
}
