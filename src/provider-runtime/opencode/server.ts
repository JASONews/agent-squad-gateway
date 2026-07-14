import {
  createOpencode,
  type Config,
  type OpencodeClient,
  type ServerOptions,
} from '@opencode-ai/sdk/v2';

export const OPENCODE_CONFIG = {
  permission: { '*': 'deny' as const },
  mcp: {},
  plugin: [],
} satisfies Config;

export interface OpenCodeServerHandle {
  client: OpencodeClient;
  close(): void | Promise<void>;
}

export type OpenCodeServerFactory = (
  options: ServerOptions,
) => Promise<OpenCodeServerHandle>;

const realOpenCodeServerFactory: OpenCodeServerFactory = async (options) => {
  const instance = await createOpencode(options);
  return {
    client: instance.client,
    close: () => instance.server.close(),
  };
};

export class OpenCodeServer {
  private handle: OpenCodeServerHandle | null = null;
  private starting: Promise<OpenCodeServerHandle> | null = null;

  constructor(private readonly factory: OpenCodeServerFactory = realOpenCodeServerFactory) {}

  async start(): Promise<OpenCodeServerHandle> {
    if (this.handle) return this.handle;
    if (this.starting) return this.starting;
    this.starting = this.factory({
      hostname: '127.0.0.1',
      port: 0,
      config: OPENCODE_CONFIG,
    });
    try {
      this.handle = await this.starting;
      return this.handle;
    } finally {
      this.starting = null;
    }
  }

  async close(): Promise<void> {
    const handle = this.handle ?? (this.starting ? await this.starting : null);
    this.handle = null;
    if (handle) await handle.close();
  }
}
