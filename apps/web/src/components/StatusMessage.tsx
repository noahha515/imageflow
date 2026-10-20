import type { ProcessErrorInfo } from '../types';

export function ErrorMessage({ error }: { error: ProcessErrorInfo }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
      <p className="font-semibold text-red-900">{error.title}</p>
      <p className="mt-1 text-red-800">{error.message}</p>
      {error.details.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-red-800">
          {error.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {(error.code || error.requestId) && (
        <p className="mt-2 font-mono text-xs text-red-700/80">
          {error.code}
          {error.requestId && ` · request ${error.requestId}`}
        </p>
      )}
    </div>
  );
}
