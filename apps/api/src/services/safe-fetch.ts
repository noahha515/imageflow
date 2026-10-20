import { lookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { AppError } from '../utils/errors.js';
import { bareHostname, isPublicAddress } from './url-policy.js';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveFn = (hostname: string) => Promise<ResolvedAddress[]>;
export type RequestFn = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;
export type FetchImage = (url: URL) => Promise<Buffer>;

export interface SafeFetchOptions {
  maxBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  /** Injected for tests; defaults to the OS resolver. */
  resolve?: ResolveFn;
  /** Injected for tests; defaults to https.request. */
  request?: RequestFn;
}

const defaultResolve: ResolveFn = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve once and require that *every* returned address is public. Rejecting
 * when any address is private stops attackers mixing a public and a private
 * record and hoping the client picks the private one.
 */
export async function resolveSafeAddress(
  hostname: string,
  resolve: ResolveFn,
): Promise<ResolvedAddress> {
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new AppError('DISALLOWED_DESTINATION', 'The destination address is not allowed.');
    }
    return { address: hostname, family: literalFamily };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new AppError('UPSTREAM_ERROR', 'The source host could not be resolved.');
  }
  const first = addresses[0];
  if (!first) {
    throw new AppError('UPSTREAM_ERROR', 'The source host could not be resolved.');
  }
  if (!addresses.every((a) => isPublicAddress(a.address))) {
    throw new AppError('DISALLOWED_DESTINATION', 'The destination address is not allowed.');
  }
  return first;
}

function timeoutError(): AppError {
  return new AppError('UPSTREAM_TIMEOUT', 'The source image took too long to respond.');
}

/**
 * Creates a fetcher that downloads an image while defending against SSRF:
 *
 * - DNS is resolved exactly once and validated; the TCP connection is then made
 *   to that IP literal, so there is no second lookup an attacker could rebind.
 * - TLS still verifies the certificate against the original hostname via SNI
 *   (`servername`), and the Host header carries the original host.
 * - Redirects are never followed (node:https does not follow them; we reject 3xx).
 * - The body is streamed with a hard byte cap; Content-Length is only a hint.
 */
export function createSafeFetcher(options: SafeFetchOptions): FetchImage {
  const resolve = options.resolve ?? defaultResolve;
  const request = options.request ?? httpsRequest;

  return async function fetchImage(url: URL): Promise<Buffer> {
    const startedAt = Date.now();
    const hostname = bareHostname(url);

    let timer: NodeJS.Timeout | undefined;
    const target = await Promise.race([
      resolveSafeAddress(hostname, resolve),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), options.totalTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    const remainingMs = Math.max(1, options.totalTimeoutMs - (Date.now() - startedAt));
    return download({ url, hostname, target, request, remainingMs, ...options });
  };
}

interface DownloadArgs extends SafeFetchOptions {
  url: URL;
  hostname: string;
  target: ResolvedAddress;
  request: RequestFn;
  remainingMs: number;
}

function download(args: DownloadArgs): Promise<Buffer> {
  const { url, hostname, target, request, maxBytes } = args;

  return new Promise<Buffer>((resolve, reject) => {
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    const finish = (err: AppError | null, body?: Buffer) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      if (err) {
        req.destroy();
        reject(err);
      } else {
        resolve(body as Buffer);
      }
    };

    const req = request(
      {
        protocol: 'https:',
        host: target.address, // IP literal: Node performs no DNS lookup.
        family: target.family,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        // SNI must be a hostname, never an IP literal.
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        headers: {
          host: url.host,
          'user-agent': 'ImageFlow/1.0',
          accept: 'image/jpeg,image/png,image/webp',
          'accept-encoding': 'identity',
        },
      },
      (res) => handleResponse(res, maxBytes, finish),
    );

    timers.push(setTimeout(() => finish(timeoutError()), args.remainingMs));
    req.on('socket', (socket) => {
      const connectTimer = setTimeout(() => finish(timeoutError()), args.connectTimeoutMs);
      timers.push(connectTimer);
      socket.once(socket instanceof TLSSocket ? 'secureConnect' : 'connect', () =>
        clearTimeout(connectTimer),
      );
    });
    req.on('error', () =>
      finish(new AppError('UPSTREAM_ERROR', 'The source image could not be fetched.')),
    );
    req.end();
  });
}

function handleResponse(
  res: IncomingMessage,
  maxBytes: number,
  finish: (err: AppError | null, body?: Buffer) => void,
): void {
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    res.resume();
    return finish(
      new AppError('UPSTREAM_REDIRECT', 'The source URL redirected; redirects are not followed.'),
    );
  }
  if (status !== 200) {
    res.resume();
    return finish(
      new AppError('UPSTREAM_ERROR', `The source server responded with status ${status}.`),
    );
  }
  const encoding = res.headers['content-encoding'];
  if (encoding && encoding !== 'identity') {
    res.resume();
    return finish(new AppError('UPSTREAM_ERROR', 'The source server returned an encoded body.'));
  }

  const tooLarge = () =>
    new AppError(
      'IMAGE_TOO_LARGE',
      `The source image exceeds the ${maxBytes / 1024 / 1024} MB limit.`,
    );

  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    return finish(tooLarge());
  }

  const chunks: Buffer[] = [];
  let received = 0;
  res.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxBytes) {
      res.destroy();
      finish(tooLarge());
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => finish(null, Buffer.concat(chunks)));
  res.on('close', () => {
    if (!res.complete) {
      finish(new AppError('UPSTREAM_ERROR', 'The source image download was interrupted.'));
    }
  });
  res.on('error', () =>
    finish(new AppError('UPSTREAM_ERROR', 'The source image download was interrupted.')),
  );
}
