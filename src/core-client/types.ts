export interface CoreHealth {
  ok: boolean;
  version: string;
  db_ok: boolean;
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

export interface CoreChoiceOption {
  id: string;
  label: string;
  tradeoff?: string;
}

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

export interface AgentSquadCoreEvent {
  type: string;
  payload: Record<string, unknown>;
}
