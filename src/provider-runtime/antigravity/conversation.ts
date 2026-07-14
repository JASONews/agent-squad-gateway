import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getAntigravityConversationId(
  homeDir: string,
  workspace: string,
): string | null {
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    return null;
  }

  const cachePath = join(
    homeDir,
    '.gemini',
    'antigravity-cli',
    'cache',
    'last_conversations.json',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const value = (parsed as Record<string, unknown>)[realWorkspace];
  return typeof value === 'string' && UUID_SHAPE.test(value) ? value : null;
}

export function formatAgyTimeout(ms: number | null): string {
  if (ms === null) return '8760h';
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes}m`;
}
