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
