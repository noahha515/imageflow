import { describe, expect, it } from 'vitest';
import { isPublicAddress, validateSourceUrl } from '../src/services/url-policy.js';
import { AppError } from '../src/utils/errors.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof AppError ? err.code : 'NOT_APP_ERROR';
  }
}

describe('validateSourceUrl', () => {
  it('accepts public HTTPS URLs', () => {
    expect(validateSourceUrl('https://images.example.com/cat.jpg').hostname).toBe(
      'images.example.com',
    );
    expect(validateSourceUrl('https://93.184.216.34/a.png').hostname).toBe('93.184.216.34');
  });

  it.each([
    ['not a url', 'INVALID_URL'],
    ['https://', 'INVALID_URL'],
    ['http://example.com/a.jpg', 'INVALID_URL'],
    ['file:///etc/passwd', 'INVALID_URL'],
    ['ftp://example.com/a.jpg', 'INVALID_URL'],
    ['gopher://example.com/', 'INVALID_URL'],
    ['https://user:pass@example.com/a.jpg', 'INVALID_URL'],
    ['https://user@example.com/a.jpg', 'INVALID_URL'],
  ])('rejects malformed or non-HTTPS URL %s', (url, code) => {
    expect(codeOf(() => validateSourceUrl(url))).toBe(code);
  });

  it.each([
    'https://localhost/a.jpg',
    'https://LOCALHOST./a.jpg',
    'https://foo.localhost/a.jpg',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://printer.local/a.jpg',
    'https://intranet/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://127.1/a.jpg',
    'https://2130706433/a.jpg',
    'https://0x7f000001/a.jpg',
    'https://0.0.0.0/a.jpg',
    'https://10.1.2.3/a.jpg',
    'https://172.16.0.1/a.jpg',
    'https://192.168.1.1/a.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.100.100.200/a.jpg',
    'https://224.0.0.1/a.jpg',
    'https://[::1]/a.jpg',
    'https://[::]/a.jpg',
    'https://[::ffff:127.0.0.1]/a.jpg',
    'https://[::ffff:a9fe:a9fe]/a.jpg',
    'https://[fd00:ec2::254]/a.jpg',
    'https://[fe80::1]/a.jpg',
    'https://[ff02::1]/a.jpg',
    'https://[64:ff9b::7f00:1]/a.jpg',
    'https://[2002:7f00:1::]/a.jpg',
    'https://example.com:8443/a.jpg',
  ])('rejects internal destination %s with 403', (url) => {
    expect(codeOf(() => validateSourceUrl(url))).toBe('DISALLOWED_DESTINATION');
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001::64'])(
    'allows public address %s',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fe80::abcd',
    'ff05::2',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks private/reserved address %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
});
