/**
 * Every error that reaches a client is an AppError. Anything else is treated as
 * an unexpected failure and reported as a generic 500 without internal details.
 */
export const ErrorCode = {
  BAD_REQUEST: 400,
  INVALID_URL: 400,
  INVALID_PARAMETER: 400,
  DISALLOWED_DESTINATION: 403,
  NOT_FOUND: 404,
  IMAGE_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  INVALID_IMAGE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  UPSTREAM_REDIRECT: 502,
  SERVICE_BUSY: 503,
  UPSTREAM_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ErrorCode;

export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ErrorCode[code];
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

export function toErrorBody(err: AppError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      requestId,
    },
  };
}
