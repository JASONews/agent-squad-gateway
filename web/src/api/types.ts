export interface AdminSessionResponse {
  csrf_token: string;
  expires_at: string;
}

export type WebUiAuthMode = 'disabled' | 'token';
export interface WebUiAuthModeResponse { mode: WebUiAuthMode }

export interface GatewayErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface GatewayRun {
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

export interface RunsResponse {
  runs: GatewayRun[];
  verifiedTargetCount: number;
}

export interface OverviewRunsResponse extends RunsResponse {
  activeRunCount: number;
  queuePressure: Array<{ targetId: string; queued: number; running: number }>;
}

export interface GatewayHealth {
  ok: boolean;
  version: string;
  db_ok: boolean;
}

export interface CoreHealth {
  ok: boolean;
  version?: string;
  connection?: { status?: string };
}

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

export interface TargetsResponse { targets: InvocationTarget[] }

export interface ProviderCapabilities {
  available: boolean;
  version?: string;
  verified: boolean;
  modelSelection: boolean;
  effortSelection: boolean;
  isolationLevel: IsolationLevel;
  streamingMode: StreamingMode;
  toolBridge: ToolBridge;
  resume: boolean;
  cancellation: boolean;
  modelOptions?: Array<{ id: string; label: string; effortOptions: string[] | null }>;
  error?: string;
}

export interface CliAvailability {
  cli: string;
  scannedAt: string;
  verificationCount: number;
  capabilities: ProviderCapabilities;
}

export interface CliAvailabilityResponse { cli_availability: CliAvailability[] }

export interface GatewayExtension {
  id: string;
  version: string;
  requiredGatewayVersion: string;
  enabled: boolean;
  endpoint: string;
  health: { ok: boolean; detail?: string };
}

export interface ExtensionsResponse { extensions: GatewayExtension[] }

export type ClientStatus = 'active' | 'disabled';
export interface GatewayClient {
  id: string; name: string; status: ClientStatus; createdAt: string; updatedAt: string;
}
export interface ClientSummary extends GatewayClient {
  credentialCount: number; grantCount: number; lastUsedAt: string | null;
}
export interface CredentialMetadata {
  id: string; clientId: string; name: string; prefix: string; createdAt: string;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; rotatedFrom: string | null;
}
export interface GrantMetadata { clientId: string; extensionId: string; targetId: string; createdAt: string }
export interface ClientsResponse { clients: ClientSummary[] }
export interface ClientDetailResponse {
  client: GatewayClient; credentials: CredentialMetadata[]; grants: GrantMetadata[];
}

export interface SettingsResponse {
  core: {
    base_url: string;
    status: string;
    version: string | null;
    last_checked_at: string | null;
  };
  bind_address: string;
  state_paths: { config: string; database: string; master_key: string; admin_secret: string };
  retention: { metadata_days: number; replay_ttl_minutes: number };
  security: { bind: string; cors: string; web_ui_auth: WebUiAuthMode };
}

export interface SetupStatusResponse {
  core_configured: boolean;
  cli_scan_complete: boolean;
  target_count: number;
  client_count: number;
  credential_count: number;
}

export interface CreatedCredentialResponse {
  id: string;
  clientId: string;
  prefix: string;
  api_key: string;
}

export interface CoreSession {
  id: string;
  root_task: string;
  repo_path: string | null;
  main_peer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoreContextTelemetry {
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
    context_window_tokens?: number;
  };
  compaction_count: number;
  last_compaction?: {
    trigger?: 'auto' | 'manual' | 'unknown';
    pre_tokens?: number;
    occurred_at: string;
  };
  updated_at?: string;
}

export interface CoreRunProgress {
  assessment: 'not_started' | 'starting' | 'progressing' | 'quiet' | 'possibly_stalled' | 'orphaned' | 'completed' | 'blocked' | 'timed_out' | 'failed';
  recommended_action: 'send' | 'wait' | 'inspect_then_wait' | 'consider_split' | 'retry_smaller' | 'resolve_block' | 'none';
  run_active: boolean;
  started_at?: string;
  last_output_at?: string;
  elapsed_ms?: number;
  idle_ms?: number;
  output_events: number;
  new_output_events: number;
  has_new_output: boolean;
  raw_tail?: string;
  recent_output_threshold_ms: number;
  stall_suspect_threshold_ms: number;
}

export interface CoreSubagent {
  id: string;
  alias: string;
  cli_type: string;
  role: string;
  status: string;
  native_session_id: string | null;
  cwd: string | null;
  model: string | null;
  reasoning_effort: string | null;
  last_seen_at: string;
  raw_tail: string | null;
  context_telemetry?: CoreContextTelemetry | null;
  progress?: CoreRunProgress | null;
}

export interface CoreMessage {
  id: string;
  session_id: string;
  from_peer_id: string | null;
  to_peer_id: string | null;
  kind: string;
  content: string | null;
  artifact_refs: string | null;
  created_at: string;
}

export interface CoreChoiceOption { id: string; label: string; tradeoff?: string }
export interface CoreChoiceRecommendation {
  option_id: string;
  reason: string;
  confidence?: 'low' | 'medium' | 'high';
}
export interface CoreChoice {
  id: string;
  session_id: string;
  requester_subagent_id: string;
  target_peer_id: string | null;
  question: string;
  options: CoreChoiceOption[];
  recommendation: CoreChoiceRecommendation | null;
  status: 'pending_main_agent' | 'resolved' | 'expired' | 'cancelled';
  selected: string | null;
  rationale: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface CoreDebugBundle {
  session: CoreSession;
  subagents: CoreSubagent[];
  messages: CoreMessage[];
  choices: CoreChoice[];
}

export interface CoreSessionsResponse { sessions: CoreSession[] }
export interface CoreChoicesResponse { choices: CoreChoice[] }
