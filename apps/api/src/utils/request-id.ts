import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Reuse a caller-supplied X-Request-Id only if it is safe to log and echo back. */
export function genRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}
