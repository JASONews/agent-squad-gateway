import {
  AntigravityProviderAdapter,
  type AntigravityProviderAdapterOptions,
} from './antigravity/adapter.js';
import { ClaudeProviderAdapter } from './claude/adapter.js';
import { CodexProviderAdapter } from './codex/adapter.js';
import { installProviderSearchPath } from './command-discovery.js';
import {
  CursorProviderAdapter,
  type CursorProviderAdapterOptions,
} from './cursor/adapter.js';
import {
  OpenCodeProviderAdapter,
  type OpenCodeProviderAdapterOptions,
} from './opencode/adapter.js';
import type { ProviderRegistry } from './registry.js';
import type { ProviderAdapter } from './types.js';

type CodexOptions = ConstructorParameters<typeof CodexProviderAdapter>[0];
type ClaudeOptions = ConstructorParameters<typeof ClaudeProviderAdapter>[0];

export const BUILT_IN_PROVIDER_COMMANDS = {
  antigravity: 'agy',
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode',
} as const;

export interface BuiltInProviderOptions {
  antigravity?: AntigravityProviderAdapterOptions;
  claude?: ClaudeOptions;
  codex?: CodexOptions;
  cursor?: CursorProviderAdapterOptions;
  opencode?: OpenCodeProviderAdapterOptions;
  factories?: Partial<{
    antigravity: (options: AntigravityProviderAdapterOptions | undefined) => ProviderAdapter;
    claude: (options: ClaudeOptions | undefined) => ProviderAdapter;
    codex: (options: CodexOptions | undefined) => ProviderAdapter;
    cursor: (options: CursorProviderAdapterOptions | undefined) => ProviderAdapter;
    opencode: (options: OpenCodeProviderAdapterOptions | undefined) => ProviderAdapter;
  }>;
}

export function registerBuiltInProviders(
  registry: ProviderRegistry,
  options: BuiltInProviderOptions = {},
): void {
  installProviderSearchPath();
  registry.register(
    'codex',
    (options.factories?.codex ?? ((adapterOptions) => new CodexProviderAdapter(adapterOptions)))(options.codex),
  );
  registry.register(
    'claude',
    (options.factories?.claude ?? ((adapterOptions) => new ClaudeProviderAdapter(adapterOptions)))(options.claude),
  );
  registry.register(
    'cursor',
    (options.factories?.cursor ?? ((adapterOptions) => new CursorProviderAdapter(adapterOptions)))(options.cursor),
  );
  registry.register(
    'opencode',
    (options.factories?.opencode ?? ((adapterOptions) => new OpenCodeProviderAdapter(adapterOptions)))(options.opencode),
  );
  registry.register(
    'antigravity',
    (options.factories?.antigravity
      ?? ((adapterOptions) => new AntigravityProviderAdapter(adapterOptions)))(options.antigravity),
  );
}
