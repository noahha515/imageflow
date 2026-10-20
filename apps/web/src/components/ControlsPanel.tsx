import type { FormEvent } from 'react';
import { cropApplies, qualityApplies } from '../services/api';
import type { CropMode, OutputFormat, TransformForm } from '../types';

interface Props {
  form: TransformForm;
  loading: boolean;
  onChange: (patch: Partial<TransformForm>) => void;
  onSubmit: () => void;
  onReset: () => void;
}

const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs ' +
  'placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-200 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400';
const labelClass = 'block text-sm font-medium text-slate-700';
const hintClass = 'mt-1 text-xs text-slate-500';

export function ControlsPanel({ form, loading, onChange, onSubmit, onReset }: Props) {
  const canCrop = cropApplies(form);
  const canQuality = qualityApplies(form);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Transformation controls"
      className="space-y-5 rounded-lg border border-slate-200 bg-white p-5"
      noValidate
    >
      <div>
        <label htmlFor="source-url" className={labelClass}>
          Source image URL
        </label>
        <input
          id="source-url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com/image.jpg"
          className={inputClass}
          value={form.url}
          onChange={(e) => onChange({ url: e.target.value })}
        />
        <p className={hintClass}>Public HTTPS JPEG, PNG or WebP, up to 10 MB.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="width" className={labelClass}>
            Width (px)
          </label>
          <input
            id="width"
            type="number"
            min={1}
            max={4096}
            step={1}
            placeholder="Auto"
            className={inputClass}
            value={form.width}
            onChange={(e) => onChange({ width: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="height" className={labelClass}>
            Height (px)
          </label>
          <input
            id="height"
            type="number"
            min={1}
            max={4096}
            step={1}
            placeholder="Auto"
            className={inputClass}
            value={form.height}
            onChange={(e) => onChange({ height: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label htmlFor="format" className={labelClass}>
          Output format
        </label>
        <select
          id="format"
          className={inputClass}
          value={form.format}
          onChange={(e) => onChange({ format: e.target.value as OutputFormat | '' })}
        >
          <option value="">Same as source</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
        </select>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="quality" className={labelClass}>
            Quality
          </label>
          <span className="text-sm text-slate-600 tabular-nums" aria-hidden="true">
            {canQuality ? form.quality : '—'}
          </span>
        </div>
        <input
          id="quality"
          type="range"
          min={1}
          max={100}
          className="mt-2 w-full accent-slate-800 disabled:opacity-40"
          value={form.quality}
          disabled={!canQuality}
          aria-describedby="quality-hint"
          onChange={(e) => onChange({ quality: Number(e.target.value) })}
        />
        <p id="quality-hint" className={hintClass}>
          {canQuality
            ? 'Lower values produce smaller files.'
            : 'Choose JPEG or WebP output to set quality.'}
        </p>
      </div>

      <div>
        <label htmlFor="crop" className={labelClass}>
          Crop mode
        </label>
        <select
          id="crop"
          className={inputClass}
          value={form.crop}
          disabled={!canCrop}
          aria-describedby="crop-hint"
          onChange={(e) => onChange({ crop: e.target.value as CropMode | '' })}
        >
          <option value="">Default (cover)</option>
          <option value="cover">Cover — fill box, crop overflow</option>
          <option value="contain">Contain — fit inside box, pad</option>
          <option value="fill">Fill — stretch to box</option>
        </select>
        <p id="crop-hint" className={hintClass}>
          {canCrop
            ? 'Applies because both width and height are set.'
            : 'Set both width and height to choose a crop mode. With one dimension, aspect ratio is preserved.'}
        </p>
      </div>

      <div className="flex gap-3 pt-1">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? 'Processing…' : 'Process Image'}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Reset
        </button>
      </div>
    </form>
  );
}
