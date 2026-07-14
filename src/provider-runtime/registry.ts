import type { ProviderAdapter } from './types.js';

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(cli: string, adapter: ProviderAdapter): void {
    if (this.adapters.has(cli)) throw new Error('duplicate_provider');
    this.adapters.set(cli, adapter);
  }

  require(cli: string): ProviderAdapter {
    const adapter = this.adapters.get(cli);
    if (!adapter) throw new Error('provider_unavailable');
    return adapter;
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    for (const adapter of this.adapters.values()) {
      if ('dispose' in adapter && typeof adapter.dispose === 'function') {
        try {
          await adapter.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Provider disposal failed');
  }
}
