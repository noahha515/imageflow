import { z } from 'zod';

/** 'true' | 'false' | hop count. A hop count trusts only entries added by known proxies. */
const trustProxy = z
  .string()
  .default('false')
  .refine((v) => /^(true|false|\d{1,2})$/.test(v), 'must be true, false or a hop count')
  .transform((v) => (v === 'true' ? true : v === 'false' ? false : Number(v)));
const int = (def: number) => z.coerce.number().int().positive().default(def);

const EnvSchema = z.object({
  PORT: int(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: trustProxy,
  RATE_LIMIT_MAX: int(60),
  RATE_LIMIT_WINDOW_MS: int(60_000),
  CACHE_TTL_SECONDS: int(3600),
  CACHE_MAX_ENTRIES: int(500),
  CACHE_MAX_BYTES: int(100 * 1024 * 1024),
  MAX_CONCURRENT_JOBS: int(8),
});

/**
 * Hard safety limits. These are deliberately not environment-configurable:
 * loosening them is a security decision that should go through code review.
 */
export const LIMITS = {
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputDimension: 4096,
  maxOutputPixels: 16_000_000,
  maxSourcePixels: 20_000_000,
  connectTimeoutMs: 3_000,
  totalTimeoutMs: 10_000,
  maxUrlLength: 2048,
} as const;

export type Limits = typeof LIMITS;

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  corsOrigins: string[];
  trustProxy: boolean | number;
  rateLimit: { max: number; windowMs: number };
  cache: { ttlSeconds: number; maxEntries: number; maxBytes: number };
  maxConcurrentJobs: number;
  limits: Limits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    rateLimit: { max: e.RATE_LIMIT_MAX, windowMs: e.RATE_LIMIT_WINDOW_MS },
    cache: {
      ttlSeconds: e.CACHE_TTL_SECONDS,
      maxEntries: e.CACHE_MAX_ENTRIES,
      maxBytes: e.CACHE_MAX_BYTES,
    },
    maxConcurrentJobs: e.MAX_CONCURRENT_JOBS,
    limits: LIMITS,
  };
}
