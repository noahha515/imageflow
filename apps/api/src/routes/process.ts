import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { parseProcessQuery, type ProcessQuery } from '../schemas/process-query.js';
import type { LruCache } from '../services/cache.js';
import { processImage, type ProcessedImage } from '../services/image-processor.js';
import type { FetchImage } from '../services/safe-fetch.js';
import { validateSourceUrl } from '../services/url-policy.js';
import { AppError } from '../utils/errors.js';

export interface ProcessRouteDeps {
  config: AppConfig;
  fetchImage: FetchImage;
  cache: LruCache<ProcessedImage>;
}

/**
 * Deterministic key: the WHATWG-normalised URL (lower-cased host, default port
 * removed, fragment dropped) plus every transformation in a fixed order, with
 * the implicit crop default made explicit so equivalent requests share an entry.
 */
export function cacheKey(url: URL, q: ProcessQuery): string {
  const normalized = new URL(url.href);
  normalized.hash = '';
  const hasBoth = q.width !== undefined && q.height !== undefined;
  return JSON.stringify([
    normalized.href,
    q.width ?? null,
    q.height ?? null,
    q.format ?? null,
    q.quality ?? null,
    hasBoth ? (q.crop ?? 'cover') : null,
  ]);
}

export function registerProcessRoute(app: FastifyInstance, deps: ProcessRouteDeps): void {
  const { config, fetchImage, cache } = deps;
  let inFlight = 0;

  app.get('/process', async (req, reply) => {
    const query = parseProcessQuery(req.query);
    const url = validateSourceUrl(query.url);
    const key = cacheKey(url, query);

    let image = cache.get(key);
    const cacheStatus = image ? 'HIT' : 'MISS';

    if (!image) {
      // Each job may hold a 10 MB download plus decoded pixels; cap concurrency
      // so a burst from many IPs cannot exhaust memory.
      if (inFlight >= config.maxConcurrentJobs) {
        throw new AppError('SERVICE_BUSY', 'The service is busy. Please retry shortly.');
      }
      inFlight++;
      const startedAt = performance.now();
      try {
        const source = await fetchImage(url);
        image = await processImage(source, query, config.limits);
      } finally {
        inFlight--;
      }
      cache.set(key, image, image.body.length);
      req.log.info(
        {
          sourceBytes: image.source.bytes,
          outputBytes: image.body.length,
          output: `${image.width}x${image.height} ${image.format}`,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'image processed',
      );
    }

    return reply
      .header('Content-Type', image.contentType)
      .header('Cache-Control', `public, max-age=${config.cache.ttlSeconds}`)
      .header('X-Cache', cacheStatus)
      .header('X-Source-Format', image.source.format)
      .header('X-Source-Width', String(image.source.width))
      .header('X-Source-Height', String(image.source.height))
      .header('X-Source-Bytes', String(image.source.bytes))
      .send(image.body);
  });
}
