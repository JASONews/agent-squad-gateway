import type {
  ModelCapabilityDetails,
  ModelCapabilityProfile,
  ModelProfileCatalog,
  ModelProfileCatalogByCli,
  ModelProfileSource,
  ProviderCapabilities,
  ResolvedModelCapabilityProfile,
} from './types.js';

const lunaProfile: ModelCapabilityProfile = {
  summary: 'Best cost/performance default for simple work and routine implementation.',
  strengths: [
    'Fast codebase exploration and straightforward edits',
    'Routine feature implementation, bug fixes, and test writing',
    'Good throughput for clearly scoped tasks',
  ],
  weaknesses: [
    'Not the first choice for ambiguous architecture or high-risk review',
    'Complex cross-system reasoning may benefit from a stronger model',
  ],
  recommendedFor: ['simple_task', 'basic_implementation', 'bug_fix', 'test_writing'],
  avoidFor: ['architecture_decision', 'security_review', 'high_risk_migration'],
  costTier: 'low',
  latencyTier: 'fast',
  priority: 90,
  effortProfiles: {
    max: {
      summary: 'Preferred Luna setting when routine implementation needs extra care.',
      strengths: ['More reliable edge-case handling while retaining strong cost/performance'],
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 92,
    },
  },
};

const solProfile: ModelCapabilityProfile = {
  summary: 'High-capability coding model for substantial implementation and review.',
  strengths: [
    'Complex implementation across multiple modules',
    'Detailed code review, debugging, and edge-case analysis',
    'Strong reasoning over repository-wide changes',
  ],
  weaknesses: [
    'More latency and resource use than a lightweight model',
    'Usually unnecessary for mechanical or very small edits',
  ],
  recommendedFor: ['complex_implementation', 'code_review', 'debugging', 'refactoring'],
  avoidFor: ['mechanical_edit', 'simple_lookup'],
  costTier: 'high',
  latencyTier: 'slow',
  priority: 80,
  effortProfiles: {
    high: {
      summary: 'Balanced setting for implementation work.',
      recommendedFor: ['complex_implementation', 'debugging', 'refactoring'],
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 86,
    },
    xhigh: {
      summary: 'Preferred setting for difficult implementation tasks.',
      recommendedFor: ['complex_implementation', 'cross_module_change'],
      priority: 88,
    },
    max: {
      summary: 'Preferred setting for demanding review and highest-risk reasoning.',
      recommendedFor: ['code_review', 'security_review', 'high_risk_migration'],
      priority: 90,
    },
  },
};

const opusProfile: ModelCapabilityProfile = {
  summary: 'Deep reasoning model for architecture, long tasks, and difficult implementation.',
  strengths: [
    'Architecture and multi-step planning',
    'Large, ambiguous implementation tasks',
    'Long-context reasoning and careful review',
  ],
  weaknesses: [
    'Higher latency and resource use',
    'Poor cost/performance for small mechanical tasks',
  ],
  recommendedFor: ['architecture_decision', 'complex_implementation', 'deep_review'],
  avoidFor: ['mechanical_edit', 'simple_lookup'],
  costTier: 'high',
  latencyTier: 'slow',
  priority: 78,
  effortProfiles: {
    max: {
      summary: 'Use for the most difficult architecture, implementation, and review tasks.',
      priority: 88,
    },
  },
};

const sonnetProfile: ModelCapabilityProfile = {
  summary: 'Balanced general-purpose coding model for implementation and review.',
  strengths: [
    'Feature implementation and refactoring',
    'Code review with good speed and quality',
    'Clear technical writing and planning',
  ],
  weaknesses: [
    'May be less reliable than the strongest model on highly ambiguous work',
  ],
  recommendedFor: ['implementation', 'refactoring', 'code_review', 'documentation'],
  avoidFor: ['highest_risk_architecture'],
  costTier: 'medium',
  latencyTier: 'medium',
  priority: 82,
};

const flashProfile: ModelCapabilityProfile = {
  summary: 'Fast, economical model for simple tasks and rapid iteration.',
  strengths: [
    'Quick repository exploration',
    'Small UI or code changes',
    'Routine transformations and summaries',
  ],
  weaknesses: [
    'Less suitable for complex reasoning or high-risk review',
  ],
  recommendedFor: ['simple_task', 'basic_implementation', 'exploration', 'summary'],
  avoidFor: ['architecture_decision', 'security_review', 'complex_debugging'],
  costTier: 'low',
  latencyTier: 'fast',
  priority: 85,
};

export const OFFICIAL_GATEWAY_MODEL_PROFILE_CATALOG_VERSION = 1;

export const OFFICIAL_GATEWAY_MODEL_PROFILES: ModelProfileCatalogByCli = {
  codex: {
    'gpt-5.6-luna': lunaProfile,
    'gpt-5.6-sol': solProfile,
  },
  opencode: {
    '*gpt-5.6-luna*': lunaProfile,
    '*gpt-5.6-sol*': solProfile,
    '*claude*opus*': opusProfile,
    '*claude*sonnet*': sonnetProfile,
    '*gemini*flash*': flashProfile,
  },
  antigravity: {
    'gemini-*-flash-*': flashProfile,
    'Gemini * Flash*': flashProfile,
    'gemini-*-pro-*': {
      summary: 'Higher-reasoning Gemini option for complex product and UI work.',
      strengths: ['Complex product reasoning', 'Architecture-aware front-end implementation'],
      weaknesses: ['Slower than Flash variants for routine work'],
      recommendedFor: ['complex_ui_implementation', 'product_architecture'],
      avoidFor: ['mechanical_edit'],
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 82,
    },
    'Gemini * Pro*': {
      summary: 'Higher-reasoning Gemini option for complex product and UI work.',
      strengths: ['Complex product reasoning', 'Architecture-aware front-end implementation'],
      weaknesses: ['Slower than Flash variants for routine work'],
      recommendedFor: ['complex_ui_implementation', 'product_architecture'],
      avoidFor: ['mechanical_edit'],
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 82,
    },
    'claude-*opus*-thinking': opusProfile,
    'Claude Opus*Thinking*': opusProfile,
    'claude-*sonnet*-thinking': sonnetProfile,
    'Claude Sonnet*Thinking*': sonnetProfile,
    'gpt-oss-*-medium': {
      summary: 'General-purpose open model option for routine coding and analysis.',
      strengths: ['General coding', 'Summarization', 'Independent second opinions'],
      weaknesses: ['Capability may trail the strongest hosted models on difficult work'],
      recommendedFor: ['basic_implementation', 'analysis', 'second_opinion'],
      avoidFor: ['highest_risk_review'],
      costTier: 'low',
      latencyTier: 'medium',
      priority: 65,
    },
    'GPT-OSS *Medium*': {
      summary: 'General-purpose open model option for routine coding and analysis.',
      strengths: ['General coding', 'Summarization', 'Independent second opinions'],
      weaknesses: ['Capability may trail the strongest hosted models on difficult work'],
      recommendedFor: ['basic_implementation', 'analysis', 'second_opinion'],
      avoidFor: ['highest_risk_review'],
      costTier: 'low',
      latencyTier: 'medium',
      priority: 65,
    },
  },
  claude: {
    default: {
      ...opusProfile,
      summary: 'Claude Code default alias, currently treated as the preferred Opus-class route.',
      priority: 88,
    },
    '*opus*': opusProfile,
    '*sonnet*': sonnetProfile,
    '*haiku*': {
      ...flashProfile,
      summary: 'Fast Claude option for small, clearly scoped tasks.',
    },
  },
  cursor: {
    '*gpt-5.6-luna*': lunaProfile,
    '*gpt-5.6-sol*': solProfile,
    '*claude*opus*': opusProfile,
    '*claude*sonnet*': sonnetProfile,
    '*gemini*flash*': flashProfile,
  },
  kimi: {
    default: {
      summary: 'Kimi Code ACP model for repository exploration and implementation.',
      strengths: ['Long-context repository exploration', 'Implementation through ACP workflows'],
      weaknesses: ['Available models and thinking controls depend on the local Kimi account'],
      recommendedFor: ['exploration', 'implementation', 'large_context_task'],
      avoidFor: ['routing_without_checking_discovered_options'],
      costTier: 'unknown',
      latencyTier: 'unknown',
      priority: 65,
    },
    'kimi-k2.5': {
      summary: 'Balanced Kimi coding model for long-context implementation work.',
      strengths: ['Repository-scale context', 'General implementation', 'Analysis'],
      weaknesses: ['Use a stronger specialist model for the highest-risk review'],
      recommendedFor: ['large_context_task', 'implementation', 'analysis'],
      avoidFor: ['highest_risk_security_review'],
      costTier: 'medium',
      latencyTier: 'medium',
      priority: 78,
      effortProfiles: {
        on: {
          summary: 'Enable thinking for complex implementation and analysis.',
          latencyTier: 'slow',
          priority: 82,
        },
        off: {
          summary: 'Prefer for simple work where speed matters more than deep reasoning.',
          latencyTier: 'fast',
          priority: 72,
        },
      },
    },
  },
};

function globMatches(pattern: string, modelId: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(modelId);
}

function patternSpecificity(pattern: string): [literalLength: number, wildcardCount: number] {
  return [
    pattern.replaceAll('*', '').length,
    [...pattern].filter((character) => character === '*').length,
  ];
}

function matchingProfiles(
  catalog: ModelProfileCatalog,
  modelIds: string[],
): ModelCapabilityProfile[] {
  return Object.entries(catalog)
    .filter(([pattern]) => modelIds.some((modelId) => globMatches(pattern, modelId)))
    .sort(([left], [right]) => {
      const [leftLength, leftWildcards] = patternSpecificity(left);
      const [rightLength, rightWildcards] = patternSpecificity(right);
      return leftLength - rightLength
        || rightWildcards - leftWildcards
        || left.localeCompare(right);
    })
    .map(([, profile]) => profile);
}

function mergeEffortProfiles(
  base: Record<string, ModelCapabilityDetails> | undefined,
  overlay: Record<string, ModelCapabilityDetails> | undefined,
): Record<string, ModelCapabilityDetails> | undefined {
  if (!base && !overlay) return undefined;
  const merged: Record<string, ModelCapabilityDetails> = {};
  for (const [effort, details] of Object.entries(base ?? {})) {
    merged[effort] = { ...details };
  }
  for (const [effort, details] of Object.entries(overlay ?? {})) {
    merged[effort] = { ...merged[effort], ...details };
  }
  return merged;
}

export function mergeModelCapabilityProfiles(
  base: ModelCapabilityProfile,
  overlay: ModelCapabilityProfile,
): ModelCapabilityProfile {
  const { effortProfiles: baseEffortProfiles, ...baseDetails } = base;
  const { effortProfiles: overlayEffortProfiles, ...overlayDetails } = overlay;
  const effortProfiles = mergeEffortProfiles(baseEffortProfiles, overlayEffortProfiles);
  return {
    ...baseDetails,
    ...overlayDetails,
    ...(effortProfiles ? { effortProfiles } : {}),
  };
}

export function resolveGatewayModelProfile(
  cli: string,
  modelIds: string | string[],
  userOverrides: ModelProfileCatalogByCli = {},
  selectedEffort?: string | null,
): ResolvedModelCapabilityProfile | undefined {
  const identifiers = Array.isArray(modelIds) ? modelIds : [modelIds];
  const officialMatches = matchingProfiles(
    OFFICIAL_GATEWAY_MODEL_PROFILES[cli] ?? {},
    identifiers,
  );
  const overrideMatches = matchingProfiles(userOverrides[cli] ?? {}, identifiers);
  if (officialMatches.length === 0 && overrideMatches.length === 0) return undefined;

  let officialProfile: ModelCapabilityProfile = {};
  for (const candidate of officialMatches) {
    officialProfile = mergeModelCapabilityProfiles(officialProfile, candidate);
  }
  if (selectedEffort && officialProfile.effortProfiles?.[selectedEffort]) {
    officialProfile = mergeModelCapabilityProfiles(
      officialProfile,
      officialProfile.effortProfiles[selectedEffort],
    );
  }

  let overrideProfile: ModelCapabilityProfile = {};
  for (const candidate of overrideMatches) {
    overrideProfile = mergeModelCapabilityProfiles(overrideProfile, candidate);
  }
  if (selectedEffort && overrideProfile.effortProfiles?.[selectedEffort]) {
    overrideProfile = mergeModelCapabilityProfiles(
      overrideProfile,
      overrideProfile.effortProfiles[selectedEffort],
    );
  }
  const profile = mergeModelCapabilityProfiles(officialProfile, overrideProfile);

  let source: ModelProfileSource = 'official_default';
  if (overrideMatches.length > 0) {
    source = officialMatches.length > 0 ? 'merged' : 'user_override';
  }

  return {
    ...profile,
    source,
    ...(selectedEffort && (
      officialProfile.effortProfiles?.[selectedEffort]
      || overrideProfile.effortProfiles?.[selectedEffort]
    ) ? { selectedEffort } : {}),
  };
}

export function withModelProfiles(
  cli: string,
  capabilities: ProviderCapabilities,
  userOverrides: ModelProfileCatalogByCli = {},
): ProviderCapabilities {
  if (!capabilities.modelOptions) return capabilities;
  return {
    ...capabilities,
    modelOptions: capabilities.modelOptions.map((option) => {
      const identifiers = option.id === option.label
        ? option.id
        : [option.id, option.label];
      const profile = resolveGatewayModelProfile(
        cli,
        identifiers,
        userOverrides,
      );
      const effortProfiles = profile === undefined
        ? undefined
        : Object.fromEntries(
            Object.keys(profile.effortProfiles ?? {}).flatMap((effort) => {
              const effective = resolveGatewayModelProfile(
                cli,
                identifiers,
                userOverrides,
                effort,
              );
              if (!effective?.selectedEffort) return [];
              const {
                source: _source,
                selectedEffort: _selectedEffort,
                effortProfiles: _nestedEffortProfiles,
                ...details
              } = effective;
              return [[effort, details]];
            }),
          );
      return {
        ...option,
        ...(profile === undefined
          ? {}
          : {
              profile: {
                ...profile,
                ...(effortProfiles && Object.keys(effortProfiles).length > 0
                  ? { effortProfiles }
                  : {}),
              },
            }),
      };
    }),
  };
}

export function cloneModelProfile(
  profile: ResolvedModelCapabilityProfile,
): ResolvedModelCapabilityProfile {
  return {
    ...profile,
    ...(profile.strengths === undefined ? {} : { strengths: [...profile.strengths] }),
    ...(profile.weaknesses === undefined ? {} : { weaknesses: [...profile.weaknesses] }),
    ...(profile.recommendedFor === undefined
      ? {}
      : { recommendedFor: [...profile.recommendedFor] }),
    ...(profile.avoidFor === undefined ? {} : { avoidFor: [...profile.avoidFor] }),
    ...(profile.effortProfiles === undefined
      ? {}
      : {
          effortProfiles: Object.fromEntries(
            Object.entries(profile.effortProfiles).map(([effort, details]) => [
              effort,
              {
                ...details,
                ...(details.strengths === undefined
                  ? {}
                  : { strengths: [...details.strengths] }),
                ...(details.weaknesses === undefined
                  ? {}
                  : { weaknesses: [...details.weaknesses] }),
                ...(details.recommendedFor === undefined
                  ? {}
                  : { recommendedFor: [...details.recommendedFor] }),
                ...(details.avoidFor === undefined
                  ? {}
                  : { avoidFor: [...details.avoidFor] }),
              },
            ]),
          ),
        }),
  };
}
