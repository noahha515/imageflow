import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Socket, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSafeFetcher, type RequestFn, type ResolveFn } from '../src/services/safe-fetch.js';
import { AppError } from '../src/utils/errors.js';

/**
 * No real network: DNS is an injected stub, and the transport records the
 * options the fetcher chose (to prove which IP it pinned) before redirecting
 * the connection to a local plain-HTTP test server.
 */
type Handler = (res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const PUBLIC_IP = '93.184.216.34';
let calls: RequestOptions[];

beforeEach(() => {
  calls = [];
  handler = (res) => res.end(Buffer.from('image-bytes'));
});

const toLocalServer: RequestFn = (options, callback) => {
  calls.push(options);
  return httpRequest(
    { ...options, protocol: 'http:', host: '127.0.0.1', family: 4, port },
    callback,
  );
};

const resolvesTo =
  (...addresses: string[]): ResolveFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

function fetcher(overrides: Partial<Parameters<typeof createSafeFetcher>[0]> = {}) {
  return createSafeFetcher({
    maxBytes: 1024,
    connectTimeoutMs: 500,
    totalTimeoutMs: 1000,
    resolve: resolvesTo(PUBLIC_IP),
    request: toLocalServer,
    ...overrides,
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof AppError ? err.code : `unexpected: ${String(err)}`;
}

const url = new URL('https://images.example.com/cat.jpg?v=1');

describe('safe fetcher', () => {
  it('downloads the body and connects to the validated IP with the original host for TLS/Host', async () => {
    const body = await fetcher()(url);
    expect(body.toString()).toBe('image-bytes');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: PUBLIC_IP,
      servername: 'images.example.com',
      path: '/cat.jpg?v=1',
      agent: false,
      headers: expect.objectContaining({ host: 'images.example.com' }),
    });
    expect(calls[0]?.lookup).toBeUndefined();
  });

  it('rejects hostnames that resolve to a private IP', async () => {
    expect(await errorCode(fetcher({ resolve: resolvesTo('10.0.0.5') })(url))).toBe(
      'DISALLOWED_DESTINATION',
    );
    expect(await errorCode(fetcher({ resolve: resolvesTo('::1') })(url))).toBe(
      'DISALLOWED_DESTINATION',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects when any resolved record is private, even if another is public', async () => {
    const resolve = resolvesTo(PUBLIC_IP, '169.254.169.254');
    expect(await errorCode(fetcher({ resolve })(url))).toBe('DISALLOWED_DESTINATION');
    expect(calls).toHaveLength(0);
  });

  it('is not vulnerable to DNS rebinding: resolves once and pins that address', async () => {
    // First answer is public, any later answer is loopback. A client that
    // re-resolved at connect time would end up on 127.0.0.1.
    const resolve = vi
      .fn<ResolveFn>()
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await fetcher({ resolve })(url);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls[0]?.host).toBe(PUBLIC_IP);
  });

  it('maps DNS failures to UPSTREAM_ERROR', async () => {
    const resolve: ResolveFn = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await errorCode(fetcher({ resolve })(url))).toBe('UPSTREAM_ERROR');
  });

  it('rejects redirects instead of following them', async () => {
    handler = (res) => {
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' });
      res.end();
    };
    expect(await errorCode(fetcher()(url))).toBe('UPSTREAM_REDIRECT');
    expect(calls).toHaveLength(1);
  });

  it('maps non-200 upstream responses to UPSTREAM_ERROR', async () => {
    handler = (res) => {
      res.statusCode = 404;
      res.end('nope');
    };
    expect(await errorCode(fetcher()(url))).toBe('UPSTREAM_ERROR');
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-length': '5000' });
      res.end(Buffer.alloc(5000));
    };
    expect(await errorCode(fetcher()(url))).toBe('IMAGE_TOO_LARGE');
  });

  it('enforces the byte limit while streaming when Content-Length is absent or lies', async () => {
    handler = (res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      const interval = setInterval(() => {
        if (!res.write(Buffer.alloc(512))) return;
      }, 1);
      res.on('close', () => clearInterval(interval));
    };
    expect(await errorCode(fetcher()(url))).toBe('IMAGE_TOO_LARGE');
  });

  it('times out when the upstream never responds', async () => {
    handler = () => {
      /* hang */
    };
    const started = Date.now();
    expect(await errorCode(fetcher({ totalTimeoutMs: 150 })(url))).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out when a TCP connection cannot be established', async () => {
    // A socket that never connects simulates a black-holed destination.
    const neverConnects: RequestFn = (options, callback) =>
      httpRequest(
        { ...options, protocol: 'http:', createConnection: () => new Socket() },
        callback,
      );
    const code = await errorCode(
      fetcher({ request: neverConnects, connectTimeoutMs: 100, totalTimeoutMs: 5000 })(url),
    );
    expect(code).toBe('UPSTREAM_TIMEOUT');
  });

  it('applies the overall timeout to slow DNS resolution', async () => {
    const resolve: ResolveFn = () => new Promise(() => {});
    expect(await errorCode(fetcher({ resolve, totalTimeoutMs: 100 })(url))).toBe(
      'UPSTREAM_TIMEOUT',
    );
  });

  it('refuses IP-literal URLs pointing at private ranges without resolving', async () => {
    const resolve = vi.fn<ResolveFn>();
    const code = await errorCode(fetcher({ resolve })(new URL('https://[::ffff:7f00:1]/a.jpg')));
    expect(code).toBe('DISALLOWED_DESTINATION');
    expect(resolve).not.toHaveBeenCalled();
  });
});
