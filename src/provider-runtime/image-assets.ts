import { lookup as lookupHost } from 'node:dns/promises';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProviderImageAsset,
  ProviderImageSource,
} from './types.js';

const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 8_192;

type SupportedImageMediaType = ProviderImageAsset['mediaType'];

export type ImageAssetErrorCode =
  | 'image_input_invalid'
  | 'image_input_not_supported'
  | 'image_limit_exceeded'
  | 'image_too_large'
  | 'image_fetch_failed'
  | 'image_fetch_timeout'
  | 'image_cleanup_failed';

export class ImageAssetError extends Error {
  constructor(readonly code: ImageAssetErrorCode) {
    super(code);
    this.name = 'ImageAssetError';
  }
}

export interface ImageAssetLease {
  images: ProviderImageAsset[];
  release(): Promise<void>;
}

export interface ImageAssetMaterializerLike {
  materialize(sources: ProviderImageSource[], signal: AbortSignal): Promise<ImageAssetLease>;
}

interface DownloadedImage {
  data: Buffer;
  mediaType: SupportedImageMediaType;
}

interface ImageDownloader {
  download(url: string, maxBytes: number, signal: AbortSignal): Promise<DownloadedImage>;
}

interface ImageAssetMaterializerOptions {
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
  downloader?: ImageDownloader;
  tempDirectory?: string;
}

interface SecureImageDownloaderOptions {
  fetchTimeoutMs?: number;
  maxRedirects?: number;
  resolve?: typeof lookupHost;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface DownloadRedirect {
  type: 'redirect';
  location: string;
}

interface DownloadResult extends DownloadedImage {
  type: 'image';
}

const MEDIA_EXTENSIONS: Record<SupportedImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

function fail(code: ImageAssetErrorCode): never {
  throw new ImageAssetError(code);
}

function supportedMediaType(value: string | undefined): SupportedImageMediaType | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  switch (normalized) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return normalized;
    default:
      return null;
  }
}

function hasExpectedSignature(data: Buffer, mediaType: SupportedImageMediaType): boolean {
  switch (mediaType) {
    case 'image/png':
      return data.length >= 8
        && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif':
      return data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a'
        || data.subarray(0, 6).toString('ascii') === 'GIF89a');
    case 'image/webp':
      return data.length >= 12
        && data.subarray(0, 4).toString('ascii') === 'RIFF'
        && data.subarray(8, 12).toString('ascii') === 'WEBP';
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  const value = address.toLowerCase().split('%', 1)[0]!;
  if (value.length === 0 || value.includes(':::')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] | null => {
    if (half.length === 0) return [];
    const groups = half.split(':');
    const output: number[] = [];
    for (const group of groups) {
      if (group.includes('.')) {
        const ipv4 = parseIpv4(group);
        if (!ipv4 || group !== groups.at(-1)) return null;
        output.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      output.push(Number.parseInt(group, 16));
    }
    return output;
  };

  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (allZero || loopback) return false;
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false;
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return false;
  if (bytes[0] === 0xff) return false;
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseHttpsUrl(value: string): URL {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) fail('image_input_invalid');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('image_input_invalid');
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    fail('image_input_invalid');
  }
  return url;
}

function decodeDataUrl(value: string, maxBytes: number): DownloadedImage {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) fail('image_input_invalid');
  const mediaType = supportedMediaType(match[1]);
  if (!mediaType) fail('image_input_invalid');
  const encoded = match[2]!;
  if (encoded.length === 0 || encoded.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    fail('image_too_large');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    fail('image_input_invalid');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    fail('image_input_invalid');
  }
  if (data.length > maxBytes) fail('image_too_large');
  if (!hasExpectedSignature(data, mediaType)) fail('image_input_invalid');
  return { data, mediaType };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class SecureImageDownloader implements ImageDownloader {
  private readonly fetchTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolve: typeof lookupHost;

  constructor(options: SecureImageDownloaderOptions = {}) {
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.resolve = options.resolve ?? lookupHost;
  }

  async download(value: string, maxBytes: number, signal: AbortSignal): Promise<DownloadedImage> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new DOMException('Image fetch timed out', 'TimeoutError'));
    }, this.fetchTimeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, timeout.signal]);

    try {
      let url = parseHttpsUrl(value);
      for (let redirects = 0; ; redirects += 1) {
        if (redirects > this.maxRedirects) fail('image_fetch_failed');
        const address = await this.resolvePublicAddress(url, combined);
        const result = await this.downloadOnce(url, address, maxBytes, combined);
        if (result.type === 'image') return result;
        url = parseHttpsUrl(new URL(result.location, url).toString());
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.signal.aborted) fail('image_fetch_timeout');
      if (error instanceof ImageAssetError) throw error;
      fail('image_fetch_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolvePublicAddress(url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const literalFamily = isIP(hostname);
    const addresses = literalFamily === 0
      ? await abortable(this.resolve(hostname, { all: true, verbatim: true }), signal)
      : [{ address: hostname, family: literalFamily }];
    if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
      fail('image_input_invalid');
    }
    const selected = addresses[0]!;
    if (selected.family !== 4 && selected.family !== 6) fail('image_input_invalid');
    return { address: selected.address, family: selected.family };
  }

  private downloadOnce(
    url: URL,
    address: ResolvedAddress,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<DownloadRedirect | DownloadResult> {
    return new Promise((resolve, reject) => {
      const request = requestHttps(url, {
        method: 'GET',
        signal,
        headers: {
          accept: 'image/png,image/jpeg,image/gif,image/webp',
          'user-agent': 'Agent-Squad-Gateway/0.1',
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      }, (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.resume();
          if (!location) {
            reject(new ImageAssetError('image_fetch_failed'));
            return;
          }
          resolve({ type: 'redirect', location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new ImageAssetError('image_fetch_failed'));
          return;
        }

        const mediaType = supportedMediaType(response.headers['content-type']);
        if (!mediaType) {
          response.resume();
          reject(new ImageAssetError('image_input_invalid'));
          return;
        }
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.resume();
          reject(new ImageAssetError('image_too_large'));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > maxBytes) {
            response.destroy(new ImageAssetError('image_too_large'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', reject);
        response.once('end', () => {
          const data = Buffer.concat(chunks, size);
          if (!hasExpectedSignature(data, mediaType)) {
            reject(new ImageAssetError('image_input_invalid'));
            return;
          }
          resolve({ type: 'image', data, mediaType });
        });
      });
      request.once('error', reject);
      request.end();
    });
  }
}

export class ImageAssetMaterializer implements ImageAssetMaterializerLike {
  private readonly maxImages: number;
  private readonly maxImageBytes: number;
  private readonly maxTotalBytes: number;
  private readonly downloader: ImageDownloader;
  private readonly tempDirectory: string;

  constructor(options: ImageAssetMaterializerOptions = {}) {
    this.maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.downloader = options.downloader ?? new SecureImageDownloader();
    this.tempDirectory = options.tempDirectory ?? tmpdir();
  }

  async materialize(sources: ProviderImageSource[], signal: AbortSignal): Promise<ImageAssetLease> {
    if (sources.length === 0) return { images: [], release: async () => {} };
    if (sources.length > this.maxImages) fail('image_limit_exceeded');

    const directory = await mkdtemp(join(this.tempDirectory, 'agent-squad-images-'));
    let released = false;
    const release = async () => {
      if (released) return;
      try {
        await rm(directory, { recursive: true, force: true });
        released = true;
      } catch {
        fail('image_cleanup_failed');
      }
    };

    try {
      await chmod(directory, 0o700);
      const images: ProviderImageAsset[] = [];
      let totalBytes = 0;
      for (const [index, source] of sources.entries()) {
        if (signal.aborted) throw signal.reason;
        const downloaded = source.url.startsWith('data:')
          ? decodeDataUrl(source.url, this.maxImageBytes)
          : await this.downloader.download(source.url, this.maxImageBytes, signal);
        totalBytes += downloaded.data.length;
        if (totalBytes > this.maxTotalBytes) fail('image_limit_exceeded');
        const filename = `image-${String(index + 1).padStart(2, '0')}.${MEDIA_EXTENSIONS[downloaded.mediaType]}`;
        const path = join(directory, filename);
        await writeFile(path, downloaded.data, { mode: 0o600, flag: 'wx' });
        images.push({ path, mediaType: downloaded.mediaType, detail: source.detail });
      }
      return { images, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
}
