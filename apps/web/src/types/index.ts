export type OutputFormat = 'jpeg' | 'png' | 'webp';
export type CropMode = 'cover' | 'contain' | 'fill';

/** Form state: strings for inputs, '' meaning "not set". */
export interface TransformForm {
  url: string;
  width: string;
  height: string;
  format: OutputFormat | '';
  quality: number;
  crop: CropMode | '';
}

export interface ImageInfo {
  width: number | null;
  height: number | null;
  format: string | null;
  bytes: number | null;
}

export interface ProcessResult {
  requestUrl: string;
  sourceUrl: string;
  objectUrl: string;
  processed: ImageInfo;
  original: ImageInfo;
  cache: string | null;
}

export type ErrorKind =
  | 'validation'
  | 'blocked'
  | 'unsupported'
  | 'too-large'
  | 'unreachable'
  | 'rate-limited'
  | 'network'
  | 'server';

export interface ProcessErrorInfo {
  kind: ErrorKind;
  title: string;
  message: string;
  details: string[];
  code?: string;
  requestId?: string;
}

export type ProcessState =
  | { status: 'idle' }
  | { status: 'loading'; requestUrl: string }
  | { status: 'success'; result: ProcessResult }
  | { status: 'error'; error: ProcessErrorInfo; requestUrl?: string };
