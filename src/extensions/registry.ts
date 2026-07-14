import type { ExtensionContext, GatewayExtension } from './contract.js';

export class GatewayExtensionRegistry {
  private readonly extensions = new Map<string, GatewayExtension>();

  constructor(private readonly context: ExtensionContext) {}

  register(extension: GatewayExtension): void {
    const id = extension.manifest.id;
    if (this.extensions.has(id)) throw new Error('extension_already_registered');
    extension.register(this.context);
    this.extensions.set(id, extension);
  }

  async start(): Promise<void> {
    for (const extension of this.extensions.values()) await extension.start();
  }

  async stop(): Promise<void> {
    const registered = [...this.extensions.values()].reverse();
    for (const extension of registered) await extension.stop();
  }

  async health(): Promise<Record<string, { ok: boolean; detail?: string }>> {
    const result: Record<string, { ok: boolean; detail?: string }> = {};
    for (const [id, extension] of this.extensions) result[id] = await extension.health();
    return result;
  }
}
