import { describe, expect, it } from 'vitest';
import { buildCurlCommand, buildProcessUrl, validateForm } from './api';
import type { TransformForm } from '../types';

const base: TransformForm = { url: '', width: '', height: '', format: '', quality: 80, crop: '' };

describe('buildProcessUrl', () => {
  it('encodes the source URL and includes only applicable parameters', () => {
    const url = buildProcessUrl(
      {
        ...base,
        url: 'https://example.com/a b.jpg?x=1&y="2"',
        width: '800',
        height: '600',
        format: 'webp',
        crop: 'fill',
      },
      'http://localhost:3000',
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/process');
    expect(parsed.searchParams.get('url')).toBe('https://example.com/a b.jpg?x=1&y="2"');
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      width: '800',
      height: '600',
      format: 'webp',
      quality: '80',
      crop: 'fill',
    });
    expect(url).not.toContain('"');
  });

  it('omits quality for PNG/original output and crop without both dimensions', () => {
    const url = new URL(
      buildProcessUrl(
        { ...base, url: 'https://e.com/a.png', width: '100', format: 'png', crop: 'cover' },
        'http://api',
      ),
    );
    expect(url.searchParams.has('quality')).toBe(false);
    expect(url.searchParams.has('crop')).toBe(false);
    expect(url.searchParams.has('height')).toBe(false);
  });

  it('produces a curl command that embeds the exact URL', () => {
    expect(buildCurlCommand('http://localhost:3000/process?url=x')).toBe(
      'curl "http://localhost:3000/process?url=x"',
    );
  });
});

describe('validateForm', () => {
  it('requires an https URL and sane dimensions', () => {
    expect(validateForm(base)).toEqual(['Enter a source image URL.']);
    expect(validateForm({ ...base, url: 'http://e.com/a.jpg' })).toEqual([
      'The source URL must start with https://.',
    ]);
    expect(
      validateForm({ ...base, url: 'https://e.com/a.jpg', width: '0', height: '5000' }),
    ).toHaveLength(2);
    expect(validateForm({ ...base, url: 'https://e.com/a.jpg', width: '300' })).toEqual([]);
  });
});
