import type { FastifyInstance } from 'fastify';

/**
 * The API only serves simple GET requests, so no preflight handling is needed;
 * we just tell allow-listed browsers they may read the response (and the
 * metadata headers the playground uses). Non-browser clients ignore CORS.
 */
export const EXPOSED_HEADERS = [
  'Content-Length',
  'X-Cache',
  'X-Request-Id',
  'X-Source-Format',
  'X-Source-Width',
  'X-Source-Height',
  'X-Source-Bytes',
];

export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    reply.header('Vary', 'Origin');
    if (origin && allowed.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
    }
  });
}
