const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

class AdapterProtocolError extends Error {
  readonly code = 'adapter_protocol_error';

  constructor() {
    super('adapter_protocol_error');
    this.name = 'AdapterProtocolError';
  }
}

function decodeLine(line: Buffer): string {
  const content = line.at(-1) === 13 ? line.subarray(0, -1) : line;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new AdapterProtocolError();
  }
}

export async function* readBoundedLines(
  stream: NodeJS.ReadableStream,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): AsyncIterable<string> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new AdapterProtocolError();
  }

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    for await (const value of stream as AsyncIterable<Buffer | string>) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      let newline = pending.indexOf(10);
      while (newline !== -1) {
        const contentBytes = newline > 0 && pending[newline - 1] === 13 ? newline - 1 : newline;
        if (contentBytes > maxLineBytes) throw new AdapterProtocolError();
        yield decodeLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }

      const pendingContentBytes = pending.at(-1) === 13 ? pending.length - 1 : pending.length;
      if (pendingContentBytes > maxLineBytes) throw new AdapterProtocolError();
    }
  } catch (error) {
    if (error instanceof AdapterProtocolError) throw error;
    throw new AdapterProtocolError();
  }

  if (pending.length > 0) yield decodeLine(pending);
}
