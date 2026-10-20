import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../src/utils/errors.js';
import { bandedPng, buildTestApp, gif, jpeg, pixelAt, png, processUrl, webp } from './helpers.js';

const SRC = {
  jpeg: 'https://img.example.com/photo.jpg',
  png: 'https://img.example.com/logo.png',
  webp: 'https://img.example.com/pic.webp',
  banded: 'https://img.example.com/banded.png',
  tall: 'https://img.example.com/tall.jpg',
  gif: 'https://img.example.com/anim.gif',
  truncated: 'https://img.example.com/broken.jpg',
  garbage: 'https://img.example.com/garbage.jpg',
  huge: 'https://img.example.com/huge.png',
  timeout: 'https://img.example.com/slow.jpg',
};

let sources: Record<string, Buffer | Error>;
let app: FastifyInstance;

beforeAll(async () => {
  const photo = await jpeg(800, 600);
  sources = {
    [SRC.jpeg]: photo,
    [SRC.png]: await png(400, 300, 0), // fully transparent
    [SRC.webp]: await webp(640, 480),
    [SRC.banded]: await bandedPng(),
    [SRC.tall]: await jpeg(100, 1000),
    [SRC.gif]: await gif(50, 50),
    [SRC.truncated]: photo.subarray(0, Math.floor(photo.length / 2)),
    [SRC.garbage]: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 7)]),
    [SRC.huge]: await sharp({
      create: { width: 5000, height: 4500, channels: 3, background: '#888' },
    })
      .png()
      .toBuffer(),
    [SRC.timeout]: new AppError('UPSTREAM_TIMEOUT', 'The source image took too long to respond.'),
  };
});

afterEach(async () => {
  await app?.close();
});

async function get(params: Record<string, string | number>) {
  ({ app } = await buildTestApp(sources));
  return app.inject({ method: 'GET', url: processUrl(params) });
}

describe('GET /process — transformations', () => {
  it('processes a JPEG and returns real JPEG bytes with metadata headers', async () => {
    const res = await get({ url: SRC.jpeg, width: 400, height: 300 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['x-source-width']).toBe('800');
    expect(res.headers['x-source-format']).toBe('jpeg');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 400, height: 300 });
  });

  it('converts PNG to JPEG and flattens transparency onto white', async () => {
    const res = await get({ url: SRC.png, format: 'jpeg', quality: 80 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 400, height: 300, hasAlpha: false });
    const [r, g, b] = await pixelAt(res.rawPayload, 10, 10);
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(245);
  });

  it('converts to WebP', async () => {
    const res = await get({ url: SRC.jpeg, format: 'webp' });
    expect(res.headers['content-type']).toBe('image/webp');
    expect((await sharp(res.rawPayload).metadata()).format).toBe('webp');
  });

  it('accepts WebP input and keeps its format by default', async () => {
    const res = await get({ url: SRC.webp, width: 320 });
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 320, height: 240 });
  });

  it('preserves aspect ratio when only width is given', async () => {
    const res = await get({ url: SRC.jpeg, width: 200 });
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([200, 150]);
  });

  it('preserves aspect ratio when only height is given', async () => {
    const res = await get({ url: SRC.jpeg, height: 120 });
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([160, 120]);
  });

  it('returns the source dimensions when no resize is requested', async () => {
    const res = await get({ url: SRC.jpeg, format: 'png' });
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 800, height: 600 });
  });

  it('crop=cover fills the box and crops the overflow from the centre', async () => {
    // 800x400 -> 300x300 cover keeps the central 400x400, cutting off the green band.
    const res = await get({ url: SRC.banded, width: 300, height: 300, crop: 'cover' });
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([300, 300]);
    const [r, g] = await pixelAt(res.rawPayload, 2, 150);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
  });

  it('defaults to cover when both dimensions are given without crop', async () => {
    const res = await get({ url: SRC.banded, width: 300, height: 300 });
    const [r] = await pixelAt(res.rawPayload, 2, 150);
    expect(r).toBeGreaterThan(150);
  });

  it('crop=fill stretches to the exact box without cropping', async () => {
    const res = await get({ url: SRC.banded, width: 300, height: 300, crop: 'fill' });
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([300, 300]);
    const [r, g] = await pixelAt(res.rawPayload, 2, 150); // green band survives
    expect(g).toBeGreaterThan(150);
    expect(r).toBeLessThan(80);
  });

  it('crop=contain letterboxes inside the box with transparent padding', async () => {
    const res = await get({ url: SRC.banded, width: 300, height: 300, crop: 'contain' });
    const meta = await sharp(res.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([300, 300]);
    expect((await pixelAt(res.rawPayload, 150, 5))[3]).toBe(0); // padding
    expect((await pixelAt(res.rawPayload, 150, 150))[3]).toBe(255); // image
  });

  it('crop=contain pads with white when the output is JPEG', async () => {
    const res = await get({
      url: SRC.banded,
      width: 300,
      height: 300,
      crop: 'contain',
      format: 'jpeg',
    });
    const [r, g, b] = await pixelAt(res.rawPayload, 150, 5);
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(245);
  });

  it('applies quality: lower quality produces a smaller JPEG', async () => {
    const low = await get({ url: SRC.banded, format: 'jpeg', quality: 10 });
    await app.close();
    const high = await get({ url: SRC.banded, format: 'jpeg', quality: 95 });
    expect(low.rawPayload.length).toBeLessThan(high.rawPayload.length);
  });

  it('strips metadata from the output', async () => {
    const withExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#fff' },
    })
      .withExif({ IFD0: { Copyright: 'secret', Artist: 'someone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    sources['https://img.example.com/exif.jpg'] = withExif;
    const res = await get({ url: 'https://img.example.com/exif.jpg', width: 32 });
    expect((await sharp(res.rawPayload).metadata()).exif).toBeUndefined();
  });
});

describe('GET /process — validation', () => {
  it.each([
    [{ width: 0 }, 'width'],
    [{ width: -5 }, 'width'],
    [{ width: '12.5' }, 'width'],
    [{ width: '100px' }, 'width'],
    [{ width: 4097 }, 'width'],
    [{ height: 'abc' }, 'height'],
    [{ height: 0 }, 'height'],
    [{ quality: 0 }, 'quality'],
    [{ quality: 101 }, 'quality'],
    [{ quality: 'high' }, 'quality'],
    [{ format: 'gif' }, 'format'],
    [{ format: 'JPEG' }, 'format'],
    [{ crop: 'scale' }, 'crop'],
    [{ crop: 'cover', width: 100 }, 'crop'],
    [{ format: 'png', quality: 80 }, 'quality'],
    [{ blur: 5 }, 'query'],
  ])('rejects %o as INVALID_PARAMETER on field %s', async (params, field) => {
    const res = await get({ url: SRC.jpeg, ...params });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('INVALID_PARAMETER');
    expect(body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('rejects a repeated parameter instead of picking one', async () => {
    ({ app } = await buildTestApp(sources));
    const res = await app.inject(`/process?url=${encodeURIComponent(SRC.jpeg)}&width=1&width=2`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].field).toBe('width');
  });

  it('rejects quality for a PNG source when no output format is given', async () => {
    const res = await get({ url: SRC.png, quality: 50 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });

  it('rejects a missing url', async () => {
    ({ app } = await buildTestApp(sources));
    const res = await app.inject('/process?width=100');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'INVALID_URL',
      details: [{ field: 'url', message: 'url is required.' }],
    });
  });

  it.each(['not-a-url', 'https://', '//example.com/a.jpg'])(
    'rejects malformed url %s',
    async (url) => {
      const res = await get({ url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_URL');
    },
  );

  it('rejects plain HTTP URLs', async () => {
    const res = await get({ url: 'http://img.example.com/photo.jpg' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_URL');
  });

  it.each([
    'https://localhost/a.jpg',
    'https://192.168.0.10/a.jpg',
    'https://[fd12::1]/a.jpg',
    'https://169.254.169.254/latest/meta-data/',
  ])('rejects internal destination %s with 403 without fetching', async (url) => {
    const built = await buildTestApp(sources);
    app = built.app;
    const res = await app.inject(processUrl({ url }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DISALLOWED_DESTINATION');
    expect(built.fetchImage).not.toHaveBeenCalled();
  });
});

describe('GET /process — limits and bad input', () => {
  it('rejects output whose computed height exceeds 4096px (413)', async () => {
    const res = await get({ url: SRC.tall, width: 1000 }); // 100x1000 -> 1000x10000
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('rejects output above the 16 MP pixel budget (413)', async () => {
    const res = await get({ url: SRC.jpeg, width: 4096, height: 4096 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.message).toContain('4096x4096');
  });

  it('rejects sources above the 20 MP input pixel limit (413)', async () => {
    const res = await get({ url: SRC.huge, width: 100 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('rejects an unsupported input type by content, not extension (415)', async () => {
    const res = await get({ url: SRC.gif }); // .gif bytes served at a URL; extension irrelevant
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('rejects a truncated JPEG (422)', async () => {
    const res = await get({ url: SRC.truncated, width: 100 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_IMAGE');
  });

  it('rejects bytes that only look like a JPEG (422)', async () => {
    const res = await get({ url: SRC.garbage });
    expect(res.statusCode).toBe(422);
  });

  it('maps an upstream timeout to 504', async () => {
    const res = await get({ url: SRC.timeout });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('hides unexpected internal errors behind a generic 500', async () => {
    sources['https://img.example.com/boom.jpg'] = new Error(
      'ENOENT: /srv/internal/secret/path.ts at Object.<anonymous>',
    );
    const res = await get({ url: 'https://img.example.com/boom.jpg' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
    expect(res.body).not.toMatch(/secret|ENOENT|stack|\.ts/);
  });
});
