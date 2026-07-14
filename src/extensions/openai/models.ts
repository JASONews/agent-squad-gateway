import type { ExtensionRepository } from '../../control-plane/extensions.js';
import type { GrantRepository } from '../../control-plane/grants.js';
import type { TargetRepository } from '../../control-plane/targets.js';
import type { InvocationTarget } from '../../control-plane/types.js';
import { OpenAIError } from './errors.js';

export const OPENAI_EXTENSION_ID = 'openai';

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'agent-squad-gateway';
}

export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}

interface ModelDependencies {
  extensions: ExtensionRepository;
  grants: GrantRepository;
  targets: TargetRepository;
}

function model(id: string, target: InvocationTarget): OpenAIModel {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.parse(target.createdAt) / 1000),
    owned_by: 'agent-squad-gateway',
  };
}

export function listOpenAIModels(clientId: string, deps: ModelDependencies): OpenAIModelList {
  const enabled = deps.extensions.list()
    .some((extension) => extension.id === OPENAI_EXTENSION_ID && extension.enabled);
  if (!enabled) {
    throw new OpenAIError(
      403,
      'The OpenAI extension is disabled',
      'permission_error',
      null,
      'extension_disabled',
    );
  }

  const models = new Map<string, OpenAIModel>();
  const extensionGrants = deps.grants.listForClient(clientId)
    .filter((grant) => grant.extensionId === OPENAI_EXTENSION_ID);
  for (const grant of extensionGrants) {
    const target = deps.targets.get(grant.targetId);
    if (!target) continue;
    try {
      deps.grants.authorize(clientId, OPENAI_EXTENSION_ID, target.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'authorization_denied') continue;
      throw error;
    }
    for (const id of [target.id, ...target.aliases]) models.set(id, model(id, target));
  }

  return {
    object: 'list',
    data: [...models.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  };
}
