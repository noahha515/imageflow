import sharp, { type FitEnum, type Metadata, type Sharp } from 'sharp';
import type { Limits } from '../config.js';
import type { CropMode, OutputFormat } from '../schemas/process-query.js';
import { AppError } from '../utils/errors.js';

// We run our own bounded output cache; libvips' operation cache would only add
// unbounded-looking memory growth on a server handling arbitrary images.
sharp.cache(false);

export type SourceFormat = OutputFormat;

export interface TransformOptions {
  width?: number;
  height?: number;
  format?: OutputFormat;
  quality?: number;
  crop?: CropMode;
}

export interface ProcessedImage {
  body: Buffer;
  format: OutputFormat;
  contentType: string;
  width: number;
  height: number;
  source: { format: SourceFormat; width: number; height: number; bytes: number };
}

export const CONTENT_TYPES: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const SHARP_FIT: Record<CropMode, keyof FitEnum> = {
  cover: 'cover',
  contain: 'contain',
  fill: 'fill',
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** Identify the format from magic bytes; Content-Type and extensions are not trusted. */
export function detectFormat(buf: Buffer): SourceFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Predict output dimensions so limits are enforced *before* any pixel work. */
export function computeOutputSize(
  source: { width: number; height: number },
  opts: Pick<TransformOptions, 'width' | 'height'>,
): { width: number; height: number } {
  const { width, height } = opts;
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) {
    return { width, height: Math.max(1, Math.round((source.height * width) / source.width)) };
  }
  if (height !== undefined) {
    return { width: Math.max(1, Math.round((source.width * height) / source.height)), height };
  }
  return { width: source.width, height: source.height };
}

function invalidImage(): AppError {
  return new AppError('INVALID_IMAGE', 'The source file is not a valid or complete image.');
}

export async function processImage(
  input: Buffer,
  opts: TransformOptions,
  limits: Limits,
): Promise<ProcessedImage> {
  const sourceFormat = detectFormat(input);
  if (!sourceFormat) {
    throw new AppError(
      'UNSUPPORTED_IMAGE_TYPE',
      'Unsupported image type. Only JPEG, PNG and WebP sources are accepted.',
    );
  }

  const open = (): Sharp => sharp(input, { limitInputPixels: limits.maxSourcePixels });

  // metadata() only parses the header (no pixel decode), so it is safe to run
  // without the pixel limit; that lets us report oversized sources as 413
  // rather than a generic decode failure. The decode below still enforces it.
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw invalidImage();
  }
  if (meta.format !== sourceFormat || !meta.width || !meta.height) throw invalidImage();

  if (meta.width * meta.height > limits.maxSourcePixels) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `The source image exceeds the ${limits.maxSourcePixels.toLocaleString('en-US')} pixel limit.`,
    );
  }

  // EXIF orientations 5–8 swap width and height once auto-rotated.
  const rotated = (meta.orientation ?? 1) >= 5;
  const source = rotated
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };

  const output = computeOutputSize(source, opts);
  if (
    output.width > limits.maxOutputDimension ||
    output.height > limits.maxOutputDimension ||
    output.width * output.height > limits.maxOutputPixels
  ) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `The output would be ${output.width}x${output.height}; the maximum is ` +
        `${limits.maxOutputDimension}px per side and ${limits.maxOutputPixels.toLocaleString('en-US')} pixels.`,
    );
  }

  const format = opts.format ?? sourceFormat;
  if (opts.quality !== undefined && format === 'png') {
    throw new AppError(
      'INVALID_PARAMETER',
      'quality applies only to jpeg and webp output; this source is PNG. Add format=jpeg or format=webp.',
      [{ field: 'quality', message: 'quality applies only to jpeg and webp output.' }],
    );
  }

  // .rotate() with no args applies EXIF orientation; metadata is stripped by default.
  let pipeline = open().rotate();

  if (opts.width !== undefined || opts.height !== undefined) {
    const crop =
      opts.width !== undefined && opts.height !== undefined ? (opts.crop ?? 'cover') : undefined;
    pipeline = pipeline.resize({
      ...(opts.width !== undefined ? { width: opts.width } : {}),
      ...(opts.height !== undefined ? { height: opts.height } : {}),
      fit: crop ? SHARP_FIT[crop] : 'inside',
      position: 'centre',
      background: format === 'jpeg' ? WHITE : TRANSPARENT,
    });
  }

  // JPEG has no alpha channel: composite onto white instead of letting it go black.
  if (format === 'jpeg') pipeline = pipeline.flatten({ background: WHITE });

  const quality = opts.quality !== undefined ? { quality: opts.quality } : {};
  pipeline =
    format === 'jpeg'
      ? pipeline.jpeg({ ...quality, mozjpeg: true })
      : format === 'webp'
        ? pipeline.webp(quality)
        : pipeline.png({ compressionLevel: 9 });

  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      body: data,
      format,
      contentType: CONTENT_TYPES[format],
      width: info.width,
      height: info.height,
      source: { format: sourceFormat, ...source, bytes: input.length },
    };
  } catch {
    throw invalidImage();
  }
}
