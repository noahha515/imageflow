import { BlockList, isIP } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './config.js';
import { registerCors } from './middleware/cors.js';
import { registerProcessRoute } from './routes/process.js';
import { LruCache } from './services/cache.js';
import type { ProcessedImage } from './services/image-processor.js';
import { createSafeFetcher, type FetchImage } from './services/safe-fetch.js';
import { isPublicAddress } from './services/url-policy.js';
import { AppError, toErrorBody } from './utils/errors.js';
import { genRequestId } from './utils/request-id.js';

export interface AppDeps {
  config: AppConfig;
  /** Override the network layer (tests). Defaults to the SSRF-safe fetcher. */
  fetchImage?: FetchImage;
  /** Clock for the cache (tests). */
  now?: () => number;
  logger?: FastifyServerOptions['logger'];
}

/**
 * Fastify ignores bare hop counts because it cannot tell whether the immediate
 * peer is really a proxy. We walk X-Forwarded-For from the right, trusting at
 * most `hops` proxies, and only ones on a private network (platform load
 * balancers) or in `trustedCidrs` (e.g. a CDN's published ranges). The first
 * untrusted address is the client, so entries a client writes further left
 * are never reached.
 */
export function trustProxyOption(
  value: boolean | number,
  trustedCidrs: readonly string[] = [],
): boolean | ((addr: string, hop: number) => boolean) {
  if (typeof value !== 'number') return value;
  const ranges = { 4: new BlockList(), 6: new BlockList() };
  for (const cidr of trustedCidrs) {
    const [ip = '', prefix = ''] = cidr.split('/');
    const family = isIP(ip) === 6 ? 6 : 4;
    ranges[family].addSubnet(ip, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
  }
  const inTrustedRange = (addr: string) => {
    const family = isIP(addr);
    return family !== 0 && ranges[family === 6 ? 6 : 4].check(addr, family === 6 ? 'ipv6' : 'ipv4');
  };
  return (addr, hop) => hop < value && (!isPublicAddress(addr) || inTrustedRange(addr));
}

function frameworkStatus(err: unknown): number {
  return typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof err.statusCode === 'number'
    ? err.statusCode
    : 500;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? {
      level: config.logLevel,
      serializers: {
        // Default fields plus the forwarded chain, to diagnose proxy/IP issues in production.
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.ip,
          forwardedFor: req.headers['x-forwarded-for'],
        }),
      },
    },
    trustProxy: trustProxyOption(config.trustProxy, config.trustedProxyCidrs),
    genReqId: genRequestId,
    requestIdHeader: false,
    bodyLimit: 1024, // GET-only API
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  registerCors(app, config.corsOrigins);

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    // In-memory store: correct for one instance only (see README).
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', `Rate limit exceeded. Try again in ${ctx.after}.`),
  });

  app.setErrorHandler((err, req, reply) => {
    let appError: AppError;
    if (err instanceof AppError) {
      appError = err;
    } else if (frameworkStatus(err) === 429) {
      appError = new AppError('RATE_LIMITED', 'Rate limit exceeded.');
    } else if (frameworkStatus(err) >= 400 && frameworkStatus(err) < 500) {
      // Fastify's own client errors (e.g. oversized body): keep the JSON shape, hide internals.
      appError = new AppError('BAD_REQUEST', 'The request could not be processed.');
    } else {
      req.log.error({ err }, 'unhandled error');
      appError = new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
    }
    if (appError.statusCode >= 500) req.log.warn({ code: appError.code }, appError.message);
    return reply
      .status(appError.statusCode)
      .header('Cache-Control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(toErrorBody(appError, req.id));
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .header('Cache-Control', 'no-store')
      .send(toErrorBody(new AppError('NOT_FOUND', 'Route not found.'), req.id)),
  );

  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  const cache = new LruCache<ProcessedImage>({
    ttlMs: config.cache.ttlSeconds * 1000,
    maxEntries: config.cache.maxEntries,
    maxBytes: config.cache.maxBytes,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const fetchImage =
    deps.fetchImage ??
    createSafeFetcher({
      maxBytes: config.limits.maxInputBytes,
      connectTimeoutMs: config.limits.connectTimeoutMs,
      totalTimeoutMs: config.limits.totalTimeoutMs,
    });

  registerProcessRoute(app, { config, fetchImage, cache });
  return app;
}
