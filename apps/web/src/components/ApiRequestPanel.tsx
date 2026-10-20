import { useCopy, type CopyStatus } from '../hooks/useCopy';
import { buildCurlCommand } from '../services/api';

interface Props {
  requestUrl: string;
  /** URL of the request currently shown in the previews, if any. */
  shownUrl: string | null;
}

const label = (status: CopyStatus, idle: string) =>
  status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : idle;

export function ApiRequestPanel({ requestUrl, shownUrl }: Props) {
  const url = useCopy();
  const curl = useCopy();
  const stale = shownUrl !== null && shownUrl !== requestUrl;

  return (
    <section
      aria-labelledby="api-request-title"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="api-request-title" className="text-sm font-semibold text-slate-900">
          API request
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => url.copy(requestUrl)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
          >
            {label(url.status, 'Copy URL')}
          </button>
          <button
            type="button"
            onClick={() => curl.copy(buildCurlCommand(requestUrl))}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
          >
            {label(curl.status, 'Copy curl')}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        <span className="font-mono font-semibold text-slate-700">GET</span>
      </p>
      <code
        data-testid="request-url"
        className="mt-1 block rounded-md bg-slate-50 px-3 py-2 font-mono text-xs break-all text-slate-800"
      >
        {requestUrl}
      </code>
      <span role="status" className="sr-only">
        {url.status === 'copied' || curl.status === 'copied' ? 'Copied to clipboard' : ''}
      </span>
      {stale && (
        <p className="mt-2 text-xs text-amber-700">
          Controls changed since the last request. Process again to update the preview.
        </p>
      )}
    </section>
  );
}
