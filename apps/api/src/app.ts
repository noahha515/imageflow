import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';
import { registerCors } from './middleware/cors.js';
import { registerProcessRoute } from './routes/process.js';
import { LruCache } from './services/cache.js';
import type { ProcessedImage } from './services/image-processor.js';
import { createSafeFetcher, type FetchImage } from './services/safe-fetch.js';
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
    logger: deps.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
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
