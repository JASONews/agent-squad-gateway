import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ImageAssetMaterializer,
  isPublicIpAddress,
  SecureImageDownloader,
} from '../../src/provider-runtime/image-assets.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-squad-image-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ImageAssetMaterializer', () => {
  it('decodes a data URL into a private temporary file and removes it on release', async () => {
    const root = await tempRoot();
    const materializer = new ImageAssetMaterializer({ tempDirectory: root });
    const lease = await materializer.materialize(
      [{ url: PNG_DATA_URL, detail: 'high' }],
      new AbortController().signal,
    );

    expect(lease.images).toEqual([{
      path: expect.stringMatching(/image-01\.png$/),
      mediaType: 'image/png',
      detail: 'high',
    }]);
    expect(await readFile(lease.images[0]!.path)).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    expect((await stat(lease.images[0]!.path)).mode & 0o777).toBe(0o600);

    const path = lease.images[0]!.path;
    await lease.release();
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.release();
  });

  it('rejects malformed data, signature mismatches, per-image size, count, and total limits', async () => {
    const root = await tempRoot();
    const signal = new AbortController().signal;

    await expect(new ImageAssetMaterializer({ tempDirectory: root }).materialize(
      [{ url: 'data:image/png;base64,not_base64', detail: 'auto' }], signal,
    )).rejects.toMatchObject({ code: 'image_input_invalid' });
    await expect(new ImageAssetMaterializer({ tempDirectory: root }).materialize(
      [{ url: `data:image/jpeg;base64,${PNG_BASE64}`, detail: 'auto' }], signal,
    )).rejects.toMatchObject({ code: 'image_input_invalid' });
    await expect(new ImageAssetMaterializer({ tempDirectory: root, maxImageBytes: 8 }).materialize(
      [{ url: PNG_DATA_URL, detail: 'auto' }], signal,
    )).rejects.toMatchObject({ code: 'image_too_large' });
    await expect(new ImageAssetMaterializer({ tempDirectory: root, maxImages: 1 }).materialize([
      { url: PNG_DATA_URL, detail: 'auto' },
      { url: PNG_DATA_URL, detail: 'auto' },
    ], signal)).rejects.toMatchObject({ code: 'image_limit_exceeded' });
    await expect(new ImageAssetMaterializer({
      tempDirectory: root,
      maxTotalBytes: Buffer.from(PNG_BASE64, 'base64').length,
    }).materialize([
      { url: PNG_DATA_URL, detail: 'auto' },
      { url: PNG_DATA_URL, detail: 'auto' },
    ], signal)).rejects.toMatchObject({ code: 'image_limit_exceeded' });
  });
});

describe('secure image URL handling', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['169.254.169.254', false],
    ['192.168.1.2', false],
    ['8.8.8.8', true],
    ['::1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['64:ff9b::7f00:1', false],
    ['2002:7f00:1::', false],
    ['2001::1', false],
    ['2606:4700:4700::1111', true],
    ['::ffff:127.0.0.1', false],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });

  it('rejects non-HTTPS, credentialed, loopback, and mixed public/private DNS targets', async () => {
    const signal = new AbortController().signal;
    const downloader = new SecureImageDownloader({
      resolve: (async () => [
        { address: '8.8.8.8', family: 4 as const },
        { address: '127.0.0.1', family: 4 as const },
      ]) as typeof import('node:dns/promises').lookup,
    });

    await expect(downloader.download('http://example.com/image.png', 1024, signal))
      .rejects.toMatchObject({ code: 'image_input_invalid' });
    await expect(downloader.download('https://user:pass@example.com/image.png', 1024, signal))
      .rejects.toMatchObject({ code: 'image_input_invalid' });
    await expect(downloader.download('https://127.0.0.1/image.png', 1024, signal))
      .rejects.toMatchObject({ code: 'image_input_invalid' });
    await expect(downloader.download('https://example.com/image.png', 1024, signal))
      .rejects.toMatchObject({ code: 'image_input_invalid' });
  });
});
