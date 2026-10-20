import { useState, type ReactNode } from 'react';
import { formatBytes } from '../services/api';
import type { ImageInfo } from '../types';

interface Props {
  title: string;
  src: string | null;
  info: ImageInfo | null;
  placeholder: ReactNode;
  note?: string | undefined;
  onDimensions?: (width: number, height: number) => void;
  /** Original images are third-party URLs: don't leak the page URL to them. */
  external?: boolean;
}

export function ImagePreview({
  title,
  src,
  info,
  placeholder,
  note,
  onDimensions,
  external,
}: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;

  const dims =
    info?.width != null && info.height != null ? `${info.width} × ${info.height}` : 'Unavailable';

  return (
    <figure className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-white">
      <figcaption className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {note && <span className="text-xs text-slate-500">{note}</span>}
      </figcaption>
      <div className="checkerboard flex aspect-[4/3] items-center justify-center overflow-hidden">
        {src && !failed ? (
          <img
            src={src}
            alt={`${title} image`}
            className="max-h-full max-w-full object-contain"
            {...(external ? { referrerPolicy: 'no-referrer' as const } : {})}
            onLoad={(e) =>
              onDimensions?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
            }
            onError={() => setFailedSrc(src)}
          />
        ) : (
          <div className="px-6 text-center text-sm text-slate-500">
            {failed ? 'The browser could not display this image.' : placeholder}
          </div>
        )}
      </div>
      <dl className="grid grid-cols-3 gap-2 border-t border-slate-200 px-4 py-3 text-xs">
        <div>
          <dt className="text-slate-500">Dimensions</dt>
          <dd className="font-medium text-slate-900 tabular-nums">{dims}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Format</dt>
          <dd className="font-medium text-slate-900 uppercase">{info?.format ?? 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">File size</dt>
          <dd className="font-medium text-slate-900 tabular-nums">
            {formatBytes(info?.bytes ?? null)}
          </dd>
        </div>
      </dl>
    </figure>
  );
}
