import { BlockList, isIP } from 'node:net';
import { AppError } from '../utils/errors.js';

/**
 * IPv4: IANA special-purpose ranges that must never be reached from the server.
 * Covers private, loopback, link-local (incl. 169.254.169.254 cloud metadata),
 * CGNAT (incl. 100.100.100.200 Alibaba metadata), multicast, reserved and
 * documentation networks.
 */
const BLOCKED_IPV4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * IPv6: allow only global unicast (2000::/3) by blocking everything outside it.
 * That single rule covers ::1, ::, IPv4-mapped (::ffff:0:0/96), IPv4-compatible,
 * NAT64 (64:ff9b::/96), ULA (fc00::/7, incl. AWS fd00:ec2::254 metadata),
 * link-local (fe80::/10) and multicast (ff00::/8). Inside 2000::/3 we also block
 * ranges that embed or tunnel to arbitrary IPv4 (Teredo, 6to4) and documentation.
 */
const BLOCKED_IPV6: ReadonlyArray<[string, number]> = [
  ['::', 3],
  ['4000::', 2],
  ['8000::', 1],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

// Separate lists per family: a single BlockList also matches IPv4 addresses
// against IPv6 rules (as ::ffff:a.b.c.d), so '::/3' would block all of IPv4.
const ipv4BlockList = new BlockList();
const ipv6BlockList = new BlockList();
for (const [net, prefix] of BLOCKED_IPV4) ipv4BlockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_IPV6) ipv6BlockList.addSubnet(net, prefix, 'ipv6');

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.home.arpa'];

/** Returns true only for syntactically valid, publicly routable unicast IPs. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  try {
    return family === 4
      ? !ipv4BlockList.check(address, 'ipv4')
      : !ipv6BlockList.check(address, 'ipv6');
  } catch {
    return false;
  }
}

/** WHATWG URL keeps IPv6 literals bracketed in `hostname`. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * Static validation of a user-supplied URL. DNS-based checks happen at fetch
 * time (see safe-fetch.ts) so the resolved address can be pinned.
 */
export function validateSourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_URL', 'Please provide a valid HTTPS image URL.');
  }

  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', 'Only HTTPS image URLs are supported.');
  }
  if (url.username || url.password) {
    throw new AppError('INVALID_URL', 'URLs with embedded credentials are not allowed.');
  }
  // Restricting to 443 prevents using the service as a port scanner.
  if (url.port !== '' && url.port !== '443') {
    throw new AppError('DISALLOWED_DESTINATION', 'Only the default HTTPS port (443) is allowed.');
  }

  // The URL parser has already normalised exotic IPv4 forms (e.g. 0x7f.1, 2130706433).
  const host = bareHostname(url).toLowerCase().replace(/\.$/, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new AppError('DISALLOWED_DESTINATION', 'The destination address is not allowed.');
    }
    return url;
  }

  if (
    host === 'localhost' ||
    !host.includes('.') ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new AppError('DISALLOWED_DESTINATION', 'The destination host is not allowed.');
  }
  return url;
}
