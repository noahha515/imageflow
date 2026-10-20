import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../src/utils/errors.js';
import { buildTestApp, jpeg, processUrl } from './helpers.js';

const SRC = 'https://img.example.com/photo.jpg';
let app: FastifyInstance;
afterEach(async () => app?.close());

describe('health', () => {
  it('returns {status: "ok"} as JSON', async () => {
    ({ app } = await buildTestApp({}));
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('caching', () => {
  it('serves repeat requests from cache without refetching or reprocessing', async () => {
    const built = await buildTestApp({ [SRC]: await jpeg(400, 300) });
    app = built.app;
    const first = await app.inject(processUrl({ url: SRC, width: 100 }));
    const second = await app.inject(processUrl({ url: SRC, width: 100 }));
    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(built.fetchImage).toHaveBeenCalledTimes(1);
  });

  it('uses normalised keys: equivalent URLs and parameter order share an entry', async () => {
    const built = await buildTestApp({ [SRC]: await jpeg(400, 300) });
    app = built.app;
    await app.inject(processUrl({ url: SRC, width: 100, height: 50 }));
    const res = await app.inject(
      processUrl({
        height: 50,
        crop: 'cover',
        width: 100,
        url: 'https://IMG.example.com:443/photo.jpg#x',
      }),
    );
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('treats different transformations as different entries', async () => {
    const built = await buildTestApp({ [SRC]: await jpeg(400, 300) });
    app = built.app;
    await app.inject(processUrl({ url: SRC, width: 100 }));
    const res = await app.inject(processUrl({ url: SRC, width: 101 }));
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('expires entries after the TTL', async () => {
    let now = 1_000_000;
    const built = await buildTestApp({ [SRC]: await jpeg(400, 300) }, { now: () => now });
    app = built.app;
    await app.inject(processUrl({ url: SRC, width: 100 }));
    now += 59_000;
    expect((await app.inject(processUrl({ url: SRC, width: 100 }))).headers['x-cache']).toBe('HIT');
    now += 2_000; // past the 60s TTL
    expect((await app.inject(processUrl({ url: SRC, width: 100 }))).headers['x-cache']).toBe(
      'MISS',
    );
    expect(built.fetchImage).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const sources: Record<string, Buffer | Error> = {
      [SRC]: new AppError('UPSTREAM_ERROR', 'The source server responded with status 503.'),
    };
    const built = await buildTestApp(sources);
    app = built.app;
    expect((await app.inject(processUrl({ url: SRC }))).statusCode).toBe(502);
    sources[SRC] = await jpeg(10, 10);
    const res = await app.inject(processUrl({ url: SRC }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
  });
});

describe('rate limiting', () => {
  it('returns 429 with the standard error shape once the per-IP limit is hit', async () => {
    ({ app } = await buildTestApp(
      { [SRC]: await jpeg(10, 10) },
      { config: { rateLimit: { max: 3, windowMs: 60_000 } } },
    ));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await app.inject(processUrl({ url: SRC }))).statusCode);
    const limited = await app.inject(processUrl({ url: SRC }));

    expect(statuses).toEqual([200, 200, 200]);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringContaining('Rate limit exceeded'),
        requestId: expect.any(String),
      },
    });
  });

  it('limits per client IP', async () => {
    ({ app } = await buildTestApp(
      { [SRC]: await jpeg(10, 10) },
      { config: { rateLimit: { max: 1, windowMs: 60_000 } } },
    ));
    const a = await app.inject({ url: processUrl({ url: SRC }), remoteAddress: '203.0.113.1' });
    const a2 = await app.inject({ url: processUrl({ url: SRC }), remoteAddress: '203.0.113.1' });
    const b = await app.inject({ url: processUrl({ url: SRC }), remoteAddress: '203.0.113.2' });
    expect([a.statusCode, a2.statusCode, b.statusCode]).toEqual([200, 429, 200]);
  });

  it('with TRUST_PROXY=1, keys on the proxy-added IP so spoofed X-Forwarded-For is ignored', async () => {
    ({ app } = await buildTestApp(
      { [SRC]: await jpeg(10, 10) },
      { config: { trustProxy: 1, rateLimit: { max: 1, windowMs: 60_000 } } },
    ));
    const send = (xff: string) =>
      app.inject({ url: processUrl({ url: SRC }), headers: { 'x-forwarded-for': xff } });
    expect((await send('1.1.1.1, 198.51.100.7')).statusCode).toBe(200);
    // Same real client (rightmost, proxy-added entry), different spoofed leftmost entry.
    expect((await send('2.2.2.2, 198.51.100.7')).statusCode).toBe(429);
    expect((await send('1.1.1.1, 198.51.100.8')).statusCode).toBe(200);
  });

  it('with TRUST_PROXY=1, does not trust X-Forwarded-For from a public peer', async () => {
    ({ app } = await buildTestApp(
      { [SRC]: await jpeg(10, 10) },
      { config: { trustProxy: 1, rateLimit: { max: 1, windowMs: 60_000 } } },
    ));
    const send = (xff: string) =>
      app.inject({
        url: processUrl({ url: SRC }),
        remoteAddress: '8.8.4.4', // public client connecting directly, not via a proxy
        headers: { 'x-forwarded-for': xff },
      });
    expect((await send('198.51.100.7')).statusCode).toBe(200);
    expect((await send('198.51.100.8')).statusCode).toBe(429);
  });

  describe('behind Render (Cloudflare edge -> Render proxy), as seen in production logs', () => {
    // Real chain from the deployed API, with a spoofed leftmost entry:
    // "<spoof>, <client>, <Cloudflare edge>, <Render proxy>"; the socket peer is the Render proxy.
    const RENDER_PROXY = '10.192.117.149';
    const chain = (spoof: string, client: string, edge = '172.71.147.51') =>
      `${spoof},${client}, ${edge}, ${RENDER_PROXY}`;

    async function renderApp(trustedProxyCidrs: string[]) {
      ({ app } = await buildTestApp(
        { [SRC]: await jpeg(10, 10) },
        {
          config: { trustProxy: 3, trustedProxyCidrs, rateLimit: { max: 1, windowMs: 60_000 } },
        },
      ));
      return (xff: string) =>
        app.inject({
          url: processUrl({ url: SRC }),
          remoteAddress: RENDER_PROXY,
          headers: { 'x-forwarded-for': xff },
        });
    }

    it('keys on the real client IP, ignoring spoofed entries and rotating edges', async () => {
      const send = await renderApp(['172.64.0.0/13']);
      expect((await send(chain('5.6.7.8', '151.240.46.246'))).statusCode).toBe(200);
      // Same client via a different spoof and a different Cloudflare edge: still limited.
      expect((await send(chain('9.9.9.9', '151.240.46.246', '172.71.146.181'))).statusCode).toBe(
        429,
      );
      // A different real client gets its own bucket.
      expect((await send(chain('5.6.7.8', '151.240.46.247'))).statusCode).toBe(200);
    });

    it('fails closed when the CDN range is not configured (keys on the edge, not the spoof)', async () => {
      const send = await renderApp([]);
      expect((await send(chain('5.6.7.8', '151.240.46.246'))).statusCode).toBe(200);
      expect((await send(chain('9.9.9.9', '151.240.46.247'))).statusCode).toBe(429);
    });
  });

  it('does not rate limit the health check', async () => {
    ({ app } = await buildTestApp({}, { config: { rateLimit: { max: 1, windowMs: 60_000 } } }));
    for (let i = 0; i < 3; i++) expect((await app.inject('/health')).statusCode).toBe(200);
  });
});

describe('error responses and request IDs', () => {
  it('uses one JSON error shape for every error class', async () => {
    ({ app } = await buildTestApp({}));
    const responses = await Promise.all([
      app.inject('/process'),
      app.inject(processUrl({ url: 'https://localhost/x.jpg' })),
      app.inject('/does-not-exist'),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([400, 403, 404]);
    for (const res of responses) {
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toBe('no-store');
      const { error } = res.json();
      expect(Object.keys(error).sort()).toEqual(
        expect.arrayContaining(['code', 'message', 'requestId']),
      );
      expect(error.requestId).toBe(res.headers['x-request-id']);
      expect(error.code).toMatch(/^[A-Z_]+$/);
    }
  });

  it('maps framework client errors (oversized body) to a 400 in the standard shape', async () => {
    ({ app } = await buildTestApp({}));
    const res = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 'x'.repeat(5000) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('echoes a safe incoming X-Request-Id and replaces an unsafe one', async () => {
    ({ app } = await buildTestApp({}));
    const ok = await app.inject({ url: '/health', headers: { 'x-request-id': 'trace-abc-12345' } });
    expect(ok.headers['x-request-id']).toBe('trace-abc-12345');
    const bad = await app.inject({
      url: '/health',
      headers: { 'x-request-id': 'x\nforged log line' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 503 instead of queueing when all processing slots are busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const image = await jpeg(10, 10);
    const built = await buildTestApp({}, { config: { maxConcurrentJobs: 1 } });
    app = built.app;
    built.fetchImage.mockImplementation(async () => {
      await gate;
      return image;
    });
    const slow = app.inject(processUrl({ url: SRC }));
    await new Promise((r) => setTimeout(r, 20));
    const busy = await app.inject(processUrl({ url: 'https://img.example.com/other.jpg' }));
    release();
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe('SERVICE_BUSY');
    expect((await slow).statusCode).toBe(200);
  });
});

describe('CORS', () => {
  it('allows configured origins to read the response and metadata headers', async () => {
    ({ app } = await buildTestApp({}));
    const res = await app.inject({ url: '/health', headers: { origin: 'http://localhost:5173' } });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-expose-headers']).toContain('X-Source-Width');
  });

  it('does not grant other origins', async () => {
    ({ app } = await buildTestApp({}));
    const res = await app.inject({ url: '/health', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
