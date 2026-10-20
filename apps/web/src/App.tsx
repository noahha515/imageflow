import { useState } from 'react';
import { ApiRequestPanel } from './components/ApiRequestPanel';
import { ControlsPanel } from './components/ControlsPanel';
import { ImagePreview } from './components/ImagePreview';
import { ErrorMessage } from './components/StatusMessage';
import { useImageProcessor } from './hooks/useImageProcessor';
import { buildProcessUrl, validateForm } from './services/api';
import type { TransformForm } from './types';

export const INITIAL_FORM: TransformForm = {
  url: '',
  width: '',
  height: '',
  format: '',
  quality: 80,
  crop: '',
};

export function App() {
  const [form, setForm] = useState<TransformForm>(INITIAL_FORM);
  const { state, process, fail, reset, setProcessedDimensions } = useImageProcessor();

  const requestUrl = buildProcessUrl(form);
  const result = state.status === 'success' ? state.result : null;
  const loading = state.status === 'loading';

  const handleSubmit = () => {
    const errors = validateForm(form);
    if (errors.length > 0) return fail(errors);
    void process(requestUrl, form.url.trim());
  };

  const handleReset = () => {
    setForm(INITIAL_FORM);
    reset();
  };

  const emptyText =
    state.status === 'idle'
      ? 'Enter an image URL and choose Process Image.'
      : loading
        ? 'Processing…'
        : 'No image';

  return (
    <div className="min-h-screen text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
          <h1 className="text-xl font-semibold tracking-tight">ImageFlow</h1>
          <p className="text-sm text-slate-600">Secure Image Processing Playground</p>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <ControlsPanel
            form={form}
            loading={loading}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            onSubmit={handleSubmit}
            onReset={handleReset}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <div aria-live="polite" className="space-y-4">
            {state.status === 'error' && <ErrorMessage error={state.error} />}
            {loading && (
              <p className="text-sm text-slate-600" role="status">
                Fetching and processing the image…
              </p>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2" aria-busy={loading}>
            <ImagePreview
              title="Original"
              external
              src={result?.sourceUrl ?? null}
              info={result?.original ?? null}
              note={result ? 'Loaded directly by your browser' : undefined}
              placeholder={emptyText}
            />
            <ImagePreview
              title="Processed"
              src={result?.objectUrl ?? null}
              info={result?.processed ?? null}
              note={result?.cache ? `Cache ${result.cache.toLowerCase()}` : undefined}
              placeholder={emptyText}
              onDimensions={setProcessedDimensions}
            />
          </div>

          <ApiRequestPanel requestUrl={requestUrl} shownUrl={result?.requestUrl ?? null} />
        </div>
      </main>
    </div>
  );
}
