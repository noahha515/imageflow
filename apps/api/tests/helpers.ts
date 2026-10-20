import sharp from 'sharp';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { LIMITS, type AppConfig } from '../src/config.js';
import type { FetchImage } from '../src/services/safe-fetch.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    corsOrigins: ['http://localhost:5173'],
    trustProxy: false,
    rateLimit: { max: 1000, windowMs: 60_000 },
    cache: { ttlSeconds: 60, maxEntries: 100, maxBytes: 50 * 1024 * 1024 },
    maxConcurrentJobs: 8,
    limits: LIMITS,
    ...overrides,
  };
}

/** Builds the app with the network replaced by an in-memory map of URL -> bytes. */
export async function buildTestApp(
  sources: Record<string, Buffer | Error>,
  opts: { config?: Partial<AppConfig>; now?: () => number } = {},
) {
  const fetchImage = vi.fn<FetchImage>(async (url) => {
    const source = sources[url.href];
    if (source === undefined) throw new Error(`unexpected fetch in test: ${url.href}`);
    if (source instanceof Error) throw source;
    return source;
  });
  const app = await buildApp({
    config: testConfig(opts.config),
    fetchImage,
    logger: false,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { app, fetchImage };
}

export function processUrl(params: Record<string, string | number>): string {
  const search = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `/process?${search}`;
}

export const solid = (width: number, height: number, alpha = 1) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha === 1 ? 3 : 4,
      background: { r: 200, g: 30, b: 30, alpha },
    },
  });

export const jpeg = (w: number, h: number) => solid(w, h).jpeg().toBuffer();
export const png = (w: number, h: number, alpha = 1) => solid(w, h, alpha).png().toBuffer();
export const webp = (w: number, h: number) => solid(w, h).webp().toBuffer();
export const gif = (w: number, h: number) => solid(w, h).gif().toBuffer();

/** 800x400 red image whose left-most 200px are green: distinguishes cover from fill. */
export async function bandedPng(): Promise<Buffer> {
  const green = await sharp({
    create: { width: 200, height: 400, channels: 3, background: { r: 0, g: 200, b: 0 } },
  })
    .png()
    .toBuffer();
  return solid(800, 400)
    .composite([{ input: green, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

export async function pixelAt(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(offset, offset + info.channels));
}
