import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface UiRouteOptions {
  root?: string;
}

const defaultRoot = fileURLToPath(new URL('../../dist/web', import.meta.url));
const immutableAsset = /-[A-Za-z0-9_-]{8,}\.[^/]+$/;
const reservedPrefixes = ['/admin', '/v1', '/health', '/assets'];

function requestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '/';
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  if (typeof accept !== 'string') return false;

  let htmlAccepted = false;
  for (const entry of accept.split(',')) {
    const [rawMediaType, ...parameters] = entry.split(';');
    const mediaType = rawMediaType?.trim().toLowerCase();
    let quality = 1;
    for (const parameter of parameters) {
      const [rawName, rawValue] = parameter.split('=', 2);
      if (rawName?.trim().toLowerCase() !== 'q') continue;
      const value = rawValue?.trim() ?? '';
      quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
        ? Number(value)
        : 0;
      break;
    }
    if (quality === 0) continue;
    if (mediaType === 'text/event-stream'
      || mediaType === 'application/json'
      || mediaType?.endsWith('+json')) return false;
    if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
      htmlAccepted = true;
    }
  }
  return htmlAccepted;
}

function ownsSpaPath(request: FastifyRequest): boolean {
  const path = requestPath(request);
  return request.method === 'GET'
    && acceptsHtml(request)
    && !reservedPrefixes.some((prefix) => path.startsWith(prefix));
}

export function registerUiRoutes(app: FastifyInstance, options: UiRouteOptions = {}): void {
  const root = options.root ?? defaultRoot;
  const indexPath = join(root, 'index.html');
  const assetsRoot = join(root, 'assets');
  if (!existsSync(indexPath) || !existsSync(assetsRoot)) return;

  app.register(fastifyStatic, {
    root: assetsRoot,
    prefix: '/assets/',
    decorateReply: false,
    cacheControl: false,
    setHeaders(response, filePath) {
      response.header(
        'cache-control',
        immutableAsset.test(basename(filePath))
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    if (!ownsSpaPath(request)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
    }
    const indexHtml = await readFile(indexPath, 'utf8');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(indexHtml);
  });
}
