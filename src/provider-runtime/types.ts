export interface ProviderInputToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ProviderInputItem =
  | { role: 'system'|'user'|'assistant'; content: string }
  | { role: 'assistant'; content: string|null; toolCalls: ProviderInputToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type ProviderImageDetail = 'auto' | 'low' | 'high';

export interface ProviderImageSource {
  url: string;
  detail: ProviderImageDetail;
}

export interface ProviderImageAsset {
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  detail: ProviderImageDetail;
}

export type ModelCostTier = 'low' | 'medium' | 'high' | 'unknown';
export type ModelLatencyTier = 'fast' | 'medium' | 'slow' | 'unknown';

export interface ModelCapabilityDetails {
  summary?: string;
  strengths?: string[];
  weaknesses?: string[];
  recommendedFor?: string[];
  avoidFor?: string[];
  costTier?: ModelCostTier;
  latencyTier?: ModelLatencyTier;
  priority?: number;
}

export interface ModelCapabilityProfile extends ModelCapabilityDetails {
  effortProfiles?: Record<string, ModelCapabilityDetails>;
}

export type ModelProfileCatalog = Record<string, ModelCapabilityProfile>;
export type ModelProfileCatalogByCli = Record<string, ModelProfileCatalog>;
export type ModelProfileSource = 'official_default' | 'user_override' | 'merged';

export interface ResolvedModelCapabilityProfile extends ModelCapabilityProfile {
  source: ModelProfileSource;
  selectedEffort?: string;
}

export interface ProviderModelOption {
  id: string;
  label: string;
  effortOptions: string[] | null;
  profile?: ResolvedModelCapabilityProfile;
}

export type ProviderProbeRequest =
  | { mode: 'static' }
  | {
      mode: 'conformance';
      targetId: string;
      model: string;
      effort: string | null;
      workspace: string;
      signal: AbortSignal;
    };

export interface ProviderCapabilities {
  available: boolean;
  version?: string;
  verified: boolean;
  verifiedAt?: string;
  modelSelection: boolean;
  effortSelection: boolean;
  modelOptions?: ProviderModelOption[];
  isolationLevel: 'strict' | 'best_effort';
  streamingMode: 'native' | 'none';
  toolBridge: 'structured_output' | 'none';
  resume: boolean;
  cancellation: boolean;
  details?: string[];
  error?: string;
}

export interface ProviderRequest {
  runId: string;
  targetId: string;
  model: string;
  effort: string | null;
  workspace: string;
  input: ProviderInputItem[];
  images?: ProviderImageAsset[];
  sessionMode: 'ephemeral' | 'persistent';
  runTimeoutMs: number | null;
  outputSchema: Record<string, unknown> | null;
  signal: AbortSignal;
}

export interface ProviderResumeRequest extends ProviderRequest { nativeSessionId: string }

export type ProviderEvent =
  | { type: 'session_started'; nativeSessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'structured_delta'; delta: string }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'failed'; code: string; message: string; nativeStateAdvanced: boolean };

export interface ProviderAdapter {
  probeCapabilities(request?: ProviderProbeRequest): Promise<ProviderCapabilities>;
  start(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  resume(request: ProviderResumeRequest): AsyncIterable<ProviderEvent>;
  cancel(runId: string): Promise<void>;
}
