import type {
  ErrorKind,
  ImageInfo,
  ProcessErrorInfo,
  ProcessResult,
  TransformForm,
} from '../types';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);

export const QUALITY_FORMATS = new Set(['jpeg', 'webp']);

export function qualityApplies(form: TransformForm): boolean {
  return QUALITY_FORMATS.has(form.format);
}

export function cropApplies(form: TransformForm): boolean {
  return form.width.trim() !== '' && form.height.trim() !== '';
}

/**
 * Build the public /process URL from the form. Parameters that do not apply
 * (quality for PNG/original, crop without both dimensions) are omitted rather
 * than sent, because the API rejects them instead of silently ignoring them.
 */
export function buildProcessUrl(form: TransformForm, base = API_BASE_URL): string {
  const params = new URLSearchParams({ url: form.url.trim() });
  if (form.width.trim()) params.set('width', form.width.trim());
  if (form.height.trim()) params.set('height', form.height.trim());
  if (form.format) params.set('format', form.format);
  if (qualityApplies(form)) params.set('quality', String(form.quality));
  if (form.crop && cropApplies(form)) params.set('crop', form.crop);
  return `${base}/process?${params.toString()}`;
}

/** URLSearchParams percent-encodes quotes, `$` and backticks, so double quotes are safe. */
export function buildCurlCommand(requestUrl: string): string {
  return `curl "${requestUrl}"`;
}

/** Cheap checks that give instant feedback; the API remains the source of truth. */
export function validateForm(form: TransformForm): string[] {
  const errors: string[] = [];
  const url = form.url.trim();
  if (!url) errors.push('Enter a source image URL.');
  else if (!/^https:\/\//i.test(url)) errors.push('The source URL must start with https://.');
  for (const [name, value] of [
    ['Width', form.width],
    ['Height', form.height],
  ] as const) {
    const v = value.trim();
    if (v && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 4096)) {
      errors.push(`${name} must be a whole number between 1 and 4096.`);
    }
  }
  return errors;
}

const ERROR_KINDS: Record<string, { kind: ErrorKind; title: string }> = {
  INVALID_URL: { kind: 'validation', title: 'Invalid request' },
  INVALID_PARAMETER: { kind: 'validation', title: 'Invalid request' },
  DISALLOWED_DESTINATION: { kind: 'blocked', title: 'Destination not allowed' },
  UNSUPPORTED_IMAGE_TYPE: { kind: 'unsupported', title: 'Unsupported image' },
  INVALID_IMAGE: { kind: 'unsupported', title: 'Unreadable image' },
  IMAGE_TOO_LARGE: { kind: 'too-large', title: 'Image too large' },
  UPSTREAM_ERROR: { kind: 'unreachable', title: 'Source unreachable' },
  UPSTREAM_REDIRECT: { kind: 'unreachable', title: 'Source redirected' },
  UPSTREAM_TIMEOUT: { kind: 'unreachable', title: 'Source timed out' },
  RATE_LIMITED: { kind: 'rate-limited', title: 'Too many requests' },
};

export class ProcessError extends Error {
  constructor(readonly info: ProcessErrorInfo) {
    super(info.message);
    this.name = 'ProcessError';
  }
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: { field: string; message: string }[];
  };
}

async function toProcessError(res: Response): Promise<ProcessError> {
  let body: ApiErrorBody = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error (e.g. a proxy page): fall through to a generic message.
  }
  const code = body.error?.code;
  const mapped = (code && ERROR_KINDS[code]) || { kind: 'server' as const, title: 'Server error' };
  return new ProcessError({
    ...mapped,
    message: body.error?.message ?? `The API responded with HTTP ${res.status}.`,
    details: (body.error?.details ?? []).map((d) => d.message),
    ...(code ? { code } : {}),
    ...(body.error?.requestId ? { requestId: body.error.requestId } : {}),
  });
}

const intHeader = (headers: Headers, name: string): number | null => {
  const value = headers.get(name);
  return value && /^\d+$/.test(value) ? Number(value) : null;
};

/**
 * Calls the public GET /process endpoint. Source-image metadata comes from the
 * X-Source-* response headers: the browser cannot reliably read bytes or size of
 * a cross-origin original, so the API (which fetched it) reports them.
 */
export async function requestProcessedImage(
  requestUrl: string,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<Omit<ProcessResult, 'objectUrl'> & { blob: Blob }> {
  let res: Response;
  try {
    // Bypass the browser HTTP cache so every click really calls the API and the
    // X-Cache label reflects the server cache, not a replayed stored response.
    res = await fetch(requestUrl, { cache: 'no-store', signal: signal ?? null });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ProcessError({
      kind: 'network',
      title: 'Network error',
      message: `Could not reach the ImageFlow API at ${API_BASE_URL}. Is it running?`,
      details: [],
    });
  }
  if (!res.ok) throw await toProcessError(res);

  const blob = await res.blob();
  const original: ImageInfo = {
    width: intHeader(res.headers, 'X-Source-Width'),
    height: intHeader(res.headers, 'X-Source-Height'),
    format: res.headers.get('X-Source-Format'),
    bytes: intHeader(res.headers, 'X-Source-Bytes'),
  };
  const processed: ImageInfo = {
    width: null, // filled in from the decoded <img> once it loads
    height: null,
    format: (res.headers.get('Content-Type') ?? blob.type).replace(/^image\//, '') || null,
    bytes: blob.size,
  };
  return { requestUrl, sourceUrl, blob, original, processed, cache: res.headers.get('X-Cache') };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
