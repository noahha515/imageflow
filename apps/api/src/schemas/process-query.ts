import { z } from 'zod';
import { LIMITS } from '../config.js';
import { AppError, type ErrorDetail } from '../utils/errors.js';

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp'] as const;
export const CROP_MODES = ['cover', 'contain', 'fill'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type CropMode = (typeof CROP_MODES)[number];

const singleString = (name: string) =>
  z.string({
    error: (issue) =>
      issue.input === undefined ? `${name} is required.` : `${name} must be provided once.`,
  });

/** Strict integer parsing: rejects "500px", "1.5", "5e2", "+5", " 5". */
const integerParam = (name: string, min: number, max: number) =>
  singleString(name)
    .regex(/^\d{1,6}$/, { error: `${name} must be an integer between ${min} and ${max}.` })
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, { error: `${name} must be an integer between ${min} and ${max}.` })
        .max(max, { error: `${name} must be an integer between ${min} and ${max}.` }),
    );

const enumParam = <T extends readonly [string, ...string[]]>(name: string, values: T) =>
  singleString(name).pipe(
    z.enum(values, { error: `${name} must be one of: ${values.join(', ')}.` }),
  );

const ProcessQuerySchema = z
  .strictObject(
    {
      url: singleString('url')
        .min(1, { error: 'url is required.' })
        .max(LIMITS.maxUrlLength, {
          error: `url must be at most ${LIMITS.maxUrlLength} characters.`,
        }),
      width: integerParam('width', 1, LIMITS.maxOutputDimension).optional(),
      height: integerParam('height', 1, LIMITS.maxOutputDimension).optional(),
      format: enumParam('format', OUTPUT_FORMATS).optional(),
      quality: integerParam('quality', 1, 100).optional(),
      crop: enumParam('crop', CROP_MODES).optional(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? `Unknown parameter(s): ${issue.keys.join(', ')}. Supported: url, width, height, format, quality, crop.`
          : undefined,
    },
  )
  .superRefine((q, ctx) => {
    if (q.crop && (q.width === undefined || q.height === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['crop'],
        message: 'crop requires both width and height.',
      });
    }
    if (q.quality !== undefined && q.format === 'png') {
      ctx.addIssue({
        code: 'custom',
        path: ['quality'],
        message: 'quality applies only to jpeg and webp output.',
      });
    }
  });

export interface ProcessQuery {
  url: string;
  width?: number;
  height?: number;
  format?: OutputFormat;
  quality?: number;
  crop?: CropMode;
}

export function parseProcessQuery(raw: unknown): ProcessQuery {
  const result = ProcessQuerySchema.safeParse(raw ?? {});
  if (result.success) {
    // Drop undefined keys so the result satisfies exactOptionalPropertyTypes.
    return Object.fromEntries(
      Object.entries(result.data).filter(([, v]) => v !== undefined),
    ) as unknown as ProcessQuery;
  }

  const details: ErrorDetail[] = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'query',
    message: issue.message,
  }));
  const urlIssue = details.find((d) => d.field === 'url');
  if (urlIssue) {
    throw new AppError('INVALID_URL', 'Please provide a valid HTTPS image URL.', details);
  }
  throw new AppError('INVALID_PARAMETER', details.map((d) => d.message).join(' '), details);
}
