# ImageFlow

A small, security-focused image processing API (Cloudinary-style URL transformations) with a React playground.

```
GET /process?url=https://example.com/photo.jpg&width=800&height=600&format=webp&crop=fill
```

The API fetches an image from a user-supplied HTTPS URL, resizes, crops and converts it with Sharp, and returns the processed bytes. Because it fetches URLs from untrusted users, it treats SSRF and resource exhaustion as primary design constraints, not afterthoughts.

---

## Contents

- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [API reference](#api-reference)
- [Security safeguards](#security-safeguards)
- [Resource limits](#resource-limits)
- [Caching](#caching)
- [Testing](#testing)
- [Deployment](#deployment)
- [Architectural trade-offs](#architectural-trade-offs)
- [Known limitations](#known-limitations)
- [What I would improve with more time](#what-i-would-improve-with-more-time)

## Technology stack

| Area    | Choice                                                                        |
| ------- | ----------------------------------------------------------------------------- |
| Runtime | Node.js 22 LTS (`>=22.12`), TypeScript (strict, `exactOptionalPropertyTypes`) |
| API     | Fastify 5, Sharp (libvips), Zod 4, `@fastify/rate-limit`                      |
| Web     | React 19, Vite, Tailwind CSS 4                                                |
| Testing | Vitest, `fastify.inject`, React Testing Library                               |
| Tooling | npm workspaces, ESLint (typescript-eslint), Prettier, Docker                  |

TypeScript is pinned to 6.0.x because typescript-eslint does not yet support TypeScript 7.

## Architecture

```
imageflow/
├── apps/api                     Fastify service (stateless, single process)
│   ├── src/app.ts               App factory: hooks, error handler, rate limit, DI
│   ├── src/server.ts            Entry point: config, listen, graceful SIGTERM shutdown
│   ├── src/config.ts            Env parsing (Zod) + hard-coded safety limits
│   ├── src/routes/process.ts    GET /process: validate → cache → fetch → process
│   ├── src/schemas/             Strict query-string schema
│   ├── src/services/
│   │   ├── url-policy.ts        Static URL + IP allow/deny rules
│   │   ├── safe-fetch.ts        DNS-pinned, redirect-free, size/time-bounded HTTPS fetch
│   │   ├── image-processor.ts   Content sniffing, limit checks, Sharp pipeline
│   │   └── cache.ts             TTL + byte-bounded LRU
│   ├── src/middleware/cors.ts   Allow-listed CORS for the playground
│   └── tests/                   Vitest suites (no real network)
└── apps/web                     React playground (static SPA)
    └── src/{components,hooks,services,types}
```

Request flow for `GET /process`:

1. **Rate limit** (per IP) runs in `onRequest`, before any work.
2. **Parse query** strictly: unknown, repeated or malformed parameters return 400.
3. **Validate URL** statically: HTTPS only, port 443, no credentials, no internal hostnames or IP literals.
4. **Cache lookup** using a normalized key; a hit returns immediately.
5. **Concurrency gate**: if `MAX_CONCURRENT_JOBS` are already running, return 503 rather than queueing.
6. **Safe fetch**: resolve DNS once, validate every address, connect to the validated IP, stream with a byte cap.
7. **Process**: sniff magic bytes, read the header, check source/output pixel budgets, then decode and transform.
8. **Store** the result in the cache (successes only) and return the bytes plus metadata headers.

The fetcher and clock are injected into `buildApp()`, which is what lets the tests run with no network and with controllable time.

## Getting started

**Prerequisites:** Node.js 22.12+ and npm 10+. Docker is optional.

```bash
npm install
cp .env.example .env     # optional; every value has a default
npm run dev              # API on http://localhost:3000, UI on http://localhost:5173
```

| Command             | What it does                                                           |
| ------------------- | ---------------------------------------------------------------------- |
| `npm run dev`       | Starts API (tsx watch) and UI (Vite) together                          |
| `npm run build`     | Compiles the API to `apps/api/dist`, bundles the UI to `apps/web/dist` |
| `npm run test`      | Runs API and web test suites                                           |
| `npm run lint`      | ESLint plus Prettier check                                             |
| `npm run typecheck` | `tsc --noEmit` for both apps                                           |

Run one side only:

```bash
npm run dev -w apps/api                  # API only
npm run dev -w apps/web                  # UI only (expects the API at VITE_API_BASE_URL)
npm run build -w apps/api && npm start -w apps/api   # compiled API
```

## Environment variables

Both apps read from the repo-root `.env`. The API also reads the process environment.

| Variable               | Default                 | Purpose                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `HOST`        | `3000` / `0.0.0.0`      | Listen address                                                                                                                                                                                                                                                                    |
| `LOG_LEVEL`            | `info`                  | Pino level (`silent` … `trace`)                                                                                                                                                                                                                                                   |
| `CORS_ORIGINS`         | `http://localhost:5173` | Comma-separated browser origins allowed to read responses                                                                                                                                                                                                                         |
| `TRUST_PROXY`          | `false`                 | `false`, or the number of proxy hops in front of the API (`1` on Render or behind an ALB). A hop is trusted only if it connects from a private network, so clients can't spoof `X-Forwarded-For` to dodge rate limits. Avoid `true`: it trusts the client-supplied leftmost entry |
| `RATE_LIMIT_MAX`       | `60`                    | Requests per IP per window                                                                                                                                                                                                                                                        |
| `RATE_LIMIT_WINDOW_MS` | `60000`                 | Rate-limit window                                                                                                                                                                                                                                                                 |
| `CACHE_TTL_SECONDS`    | `3600`                  | Cache entry lifetime; also used for `Cache-Control: max-age`                                                                                                                                                                                                                      |
| `CACHE_MAX_ENTRIES`    | `500`                   | Cache entry cap                                                                                                                                                                                                                                                                   |
| `CACHE_MAX_BYTES`      | `104857600` (100 MB)    | Cache memory cap (sum of output sizes)                                                                                                                                                                                                                                            |
| `MAX_CONCURRENT_JOBS`  | `8`                     | Fetch and process jobs allowed in flight at once                                                                                                                                                                                                                                  |
| `VITE_API_BASE_URL`    | `http://localhost:3000` | API origin used by the UI (applied at build time)                                                                                                                                                                                                                                 |

Invalid values make the API fail fast at startup. The security limits in the next sections are constants in `config.ts`, not env vars: loosening them is a security decision that should go through code review.

## API reference

### `GET /health`

```json
{ "status": "ok" }
```

Not rate limited, so it is safe to use for load-balancer health checks.

### `GET /process`

| Param     | Type                           | Required | Notes                                                     |
| --------- | ------------------------------ | -------- | --------------------------------------------------------- |
| `url`     | HTTPS URL (≤ 2048 chars)       | yes      | Must be URL-encoded                                       |
| `width`   | integer 1–4096                 | no       |                                                           |
| `height`  | integer 1–4096                 | no       |                                                           |
| `format`  | `jpeg` \| `png` \| `webp`      | no       | Defaults to the source format                             |
| `quality` | integer 1–100                  | no       | JPEG/WebP only. Sharp's default (80) applies when omitted |
| `crop`    | `cover` \| `contain` \| `fill` | no       | Requires both `width` and `height`                        |

**Strictness.** The API rejects invalid input instead of guessing or silently ignoring it:

- Unknown parameters (`?blur=5`) → 400.
- Repeated parameters (`?width=1&width=2`) → 400.
- Non-integer values (`100px`, `1.5`, `5e2`) → 400.
- `crop` without both dimensions → 400.
- `quality` with PNG output → 400. This includes a PNG source with no `format`, which is only known after the fetch.

**Resize behavior.**

| Given                | Result                                                     |
| -------------------- | ---------------------------------------------------------- |
| neither              | Source dimensions (format conversion and re-encoding only) |
| `width` only         | Width fixed, height scaled to preserve the aspect ratio    |
| `height` only        | Height fixed, width scaled to preserve the aspect ratio    |
| both, `crop` omitted | Same as `crop=cover`                                       |

**Crop modes.** When both dimensions are given, the output is always exactly `width × height`:

| Mode      | Behavior                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `cover`   | Scale to fill the box while preserving aspect ratio, then crop the overflow from the center                   |
| `contain` | Scale to fit inside the box while preserving aspect ratio, then pad: transparent for PNG/WebP, white for JPEG |
| `fill`    | Stretch to the exact box, ignoring aspect ratio                                                               |

Upscaling is allowed, within the output limits.

**Output processing.**

- EXIF orientation is applied, then **all metadata is stripped** (EXIF, GPS, ICC, XMP).
- For JPEG output, transparency is flattened onto white instead of turning black.
- JPEG output uses mozjpeg, and PNG uses compression level 9.

**Success response:** `200` with the image bytes and these headers:

```
Content-Type: image/webp
Cache-Control: public, max-age=3600
X-Cache: HIT | MISS
X-Source-Format: jpeg          # detected from magic bytes, not the URL
X-Source-Width: 1600           # after EXIF orientation
X-Source-Height: 1200
X-Source-Bytes: 524288
X-Request-Id: 7f9c…
```

The `X-Source-*` headers exist so clients, including the playground, can show accurate original-image metadata without having to read cross-origin bytes themselves.

### Examples

```bash
# Resize to an exact box (cover crop by default)
curl -o out.jpg "http://localhost:3000/process?url=https%3A%2F%2Fexample.com%2Fimage.jpg&width=500&height=300"

# PNG → JPEG at quality 80 (transparency becomes white)
curl -o out.jpg "http://localhost:3000/process?url=https%3A%2F%2Fexample.com%2Fimage.png&format=jpeg&quality=80"

# Combined: resize, stretch, convert to WebP
curl -o out.webp "http://localhost:3000/process?url=https%3A%2F%2Fexample.com%2Fimage.jpg&width=800&height=600&format=webp&crop=fill"

# Width only: aspect ratio preserved
curl -o out.png "http://localhost:3000/process?url=https%3A%2F%2Fexample.com%2Fimage.png&width=320"

# Inspect headers and errors
curl -i "http://localhost:3000/process?url=https%3A%2F%2Flocalhost%2Fa.jpg"
```

### Error format

Every error, including 404 and 429, uses the same JSON shape with `Cache-Control: no-store`:

```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "width must be an integer between 1 and 4096.",
    "details": [{ "field": "width", "message": "width must be an integer between 1 and 4096." }],
    "requestId": "2b0c4a3e-…"
  }
}
```

`details` is present only for validation errors. `requestId` matches the `X-Request-Id` header and the server log line. Stack traces, file paths and upstream error text are never returned; unexpected errors are logged server-side and reported as a generic `INTERNAL_ERROR`.

| Status | Code                     | When                                                                        |
| ------ | ------------------------ | --------------------------------------------------------------------------- |
| 400    | `INVALID_URL`            | Missing, malformed, non-HTTPS, or credential-bearing URL                    |
| 400    | `INVALID_PARAMETER`      | Any other bad, unknown or repeated parameter                                |
| 400    | `BAD_REQUEST`            | Other malformed requests rejected by the framework (e.g. an oversized body) |
| 403    | `DISALLOWED_DESTINATION` | Internal or reserved host or IP (directly or via DNS), or a non-443 port    |
| 404    | `NOT_FOUND`              | Unknown route                                                               |
| 413    | `IMAGE_TOO_LARGE`        | Source over 10 MB or 20 MP, or output over 4096 px per side or 16 MP        |
| 415    | `UNSUPPORTED_IMAGE_TYPE` | Source bytes are not JPEG, PNG or WebP                                      |
| 422    | `INVALID_IMAGE`          | Bytes claim a supported format but are corrupt or truncated                 |
| 429    | `RATE_LIMITED`           | Per-IP limit exceeded (`Retry-After` is set)                                |
| 500    | `INTERNAL_ERROR`         | Unexpected server error                                                     |
| 502    | `UPSTREAM_ERROR`         | DNS failure, TLS failure, connection error, or non-200 from the source      |
| 502    | `UPSTREAM_REDIRECT`      | Source responded with a 3xx                                                 |
| 503    | `SERVICE_BUSY`           | Concurrency cap reached; retry later                                        |
| 504    | `UPSTREAM_TIMEOUT`       | Connect (3 s) or overall (10 s) timeout                                     |

**Status code choices.** A `width` above 4096 is a 400, because the parameter itself is out of range. A _computed_ size over budget is a 413: for example, `width=1000` on a 100×1000 source would produce a 10000 px height, and `4096×4096` exceeds the 16 MP output budget.

## Security safeguards

**URL validation** (`url-policy.ts`)

- Only `https:` URLs are accepted. `http`, `file`, `ftp`, `gopher`, `data` and similar schemes are rejected.
- Embedded credentials (`user:pass@`) are rejected.
- Only port 443 is allowed, so the service can't be used to probe internal ports.
- Hostnames that are `localhost`, single-label (`intranet`), or end in `.localhost`, `.local`, `.localdomain`, `.internal` (including `metadata.google.internal`) or `.home.arpa` are rejected.
- IP literals are checked against the address policy. The WHATWG URL parser first normalizes tricks like `0x7f000001`, `2130706433` and `127.1`.

**Address policy.** Two `net.BlockList`s, one per family, are used, because a single combined list also matches IPv4 against IPv6 rules via the IPv4-mapped form.

- **IPv4:** every IANA special-purpose range is blocked: `0/8`, `10/8`, `100.64/10` (CGNAT, including Alibaba metadata), `127/8`, `169.254/16` (link-local, including AWS/GCP/Azure `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` multicast, `240/4` reserved and broadcast.
- **IPv6:** only global unicast `2000::/3` is allowed. That one rule blocks `::1`, `::`, IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, ULA `fc00::/7` (including AWS `fd00:ec2::254`), link-local `fe80::/10` and multicast `ff00::/8`. Inside `2000::/3`, Teredo/IETF `2001::/23`, 6to4 `2002::/16` (which can embed private IPv4) and the documentation ranges are also blocked.

**DNS rebinding protection** (`safe-fetch.ts`)

1. The hostname is resolved **once** (`dns.lookup`, `all: true`).
2. **Every** returned address must pass the policy. One bad record rejects the request, so an attacker can't mix a public and a private record.
3. The connection goes to **that IP literal**, so Node performs no second lookup that could be rebound. TLS still verifies the certificate against the original hostname via `servername` (SNI), and the `Host` header carries the original host. A dedicated agent per request (`agent: false`) rules out socket reuse across hosts.

This was checked against real hosts as well as in tests. `localtest.me`, which publicly resolves to 127.0.0.1, returns 403. `wrong.host.badssl.com`, `self-signed.badssl.com` and `expired.badssl.com` are rejected, which confirms that pinning the IP didn't weaken certificate verification.

**Redirects.** These are rejected, not followed (`UPSTREAM_REDIRECT`). `node:https` never follows redirects on its own.

**Content validation.** The format comes from magic bytes; `Content-Type` and file extensions are ignored. Only JPEG, PNG and WebP reach libvips, so SVG, GIF, TIFF, HEIF and other decoders are never exposed. `Accept-Encoding: identity` is requested, and encoded bodies are refused.

**Other hardening**

- Per-IP rate limiting.
- A concurrency cap.
- `X-Content-Type-Options: nosniff` on every response.
- CORS limited to an allow-list.
- Incoming `X-Request-Id` values are accepted only if they match `[A-Za-z0-9_-]{8,64}`, which prevents log injection.
- The Docker image runs as the non-root `node` user.

## Resource limits

| Limit             | Value           | Where enforced                                                                                                               |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Input size        | 10 MB           | `Content-Length` checked up front, then counted **while streaming**; the socket is destroyed as soon as the limit is crossed |
| Source pixels     | 20 MP           | Checked from the header before decoding, plus Sharp `limitInputPixels` as a backstop                                         |
| Output dimensions | 4096 px/side    | Query schema for explicit values; computed output (aspect-ratio resize) before decoding                                      |
| Output pixels     | 16 MP           | Computed before decoding (so 4096×4096 is rejected)                                                                          |
| Connect timeout   | 3 s             | TCP connect plus TLS handshake                                                                                               |
| Overall timeout   | 10 s            | Covers DNS, connect, headers and body                                                                                        |
| URL length        | 2048 chars      | Query schema                                                                                                                 |
| Concurrent jobs   | 8 (env)         | Route; returns 503 instead of queueing unboundedly                                                                           |
| Rate limit        | 60/min/IP (env) | `@fastify/rate-limit`                                                                                                        |

Why these values: 10 MB and 20 MP cover typical photos, including high-resolution phone shots. They cap each job at a 10 MB download plus at most ~80 MB of decoded RGBA, and libvips usually holds much less because it streams. With 8 concurrent jobs, a 1–2 GB task is a comfortable starting point; I haven't load-tested to confirm the exact ceiling. Sharp's own libvips operation cache is disabled, because the service has its own bounded cache.

## Caching

**What is cached.** Processed output only, in a bounded in-memory LRU (`services/cache.ts`), capped by entry count (500) and total bytes (100 MB). Each entry has a TTL (1 hour). Failures are never cached.

**Cache key.** The WHATWG-normalized source URL (lowercased host, default port removed, fragment dropped) plus every transformation in a fixed order. The implicit `crop=cover` is made explicit, so `?width=100&height=50` and `?height=50&crop=cover&width=100` share an entry.

**HTTP caching.** Successful responses send `Cache-Control: public, max-age=<TTL>`, so browsers and CDNs can cache them too. Errors send `no-store`.

**Stale sources.** If the source image changes at the same URL, ImageFlow keeps serving the old processed version until the TTL expires. Purging is not supported, and the cache doesn't revalidate with `ETag`/`Last-Modified`. Clients that need fresh output should version their source URLs (`?v=2`), which is standard practice for image CDNs.

**Multi-instance.** Each instance would have its own cache, so hit rates would fall and memory would be duplicated. The right fix is a CDN (CloudFront) in front, keyed on the full query string. It absorbs most traffic and needs no shared state in the service. If origin-side sharing matters after that, processed images can go to S3 keyed by a hash of the cache key, with Redis/ElastiCache only for hot items.

## Testing

```bash
npm run test                    # everything
npm run test -w apps/api        # 137 API tests
npm run test -w apps/web        # 11 UI tests
```

No test makes a real network request. The API's fetcher is replaced by an in-memory URL → bytes map, except in the `safe-fetch` suite. That suite injects a stub DNS resolver and a transport that **records the options the fetcher chose** (to assert which IP it pinned) and then forwards the connection to a local HTTP server. All fixtures are generated with Sharp at test time, and outputs are checked by decoding them with `sharp().metadata()` and reading individual pixels.

| Suite                | Covers                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url-policy.test.ts` | HTTPS-only; credentials; ports; `localhost` and internal suffixes; encoded IPv4 forms; private, link-local, metadata, multicast and IPv4-mapped/NAT64/6to4 IPv6 addresses                                                                                                                                                                                                                                        |
| `safe-fetch.test.ts` | DNS → private IP; mixed public/private records; **DNS rebinding** (resolver answers public then loopback: exactly one lookup, connection pinned to the public IP); redirect rejection; non-200; Content-Length and streamed size caps; response, connect and DNS timeouts                                                                                                                                        |
| `process.test.ts`    | JPEG processing; PNG → JPEG with white flattening (pixel check); WebP in and out; width-only and height-only aspect ratio; cover, fill and contain behavior (pixel checks on a banded fixture); quality affecting size; metadata stripping; every validation error; 413 for computed and pixel-budget overflow; 20 MP source; 415 for GIF; 422 for truncated and garbage bytes; 504 mapping; 500 leaking nothing |
| `app.test.ts`        | Health; cache hit/miss, key normalization, TTL expiry, failures not cached; rate limit 429 shape, per-IP keying, health exemption; uniform error shape across 400/403/404; request-ID echo and sanitization; 503 concurrency cap; CORS allow-list                                                                                                                                                                |
| `cache.test.ts`      | LRU order, byte budget, oversized entries, TTL, overwrite accounting                                                                                                                                                                                                                                                                                                                                             |
| `api.test.ts` (web)  | URL building and encoding, omitting non-applicable parameters, curl command, client validation                                                                                                                                                                                                                                                                                                                   |
| `App.test.tsx` (web) | Empty state; local validation; the request URL equals the displayed URL; previews and metadata; unsupported, unreachable and network error states; copy curl; reset; Enter to submit                                                                                                                                                                                                                             |

## UI notes

The playground calls only the public `GET /process` URL shown in the "API request" panel. The exact string displayed is the one passed to `fetch`, and a test asserts this.

**Original image.** It is shown with a plain `<img>` pointing at the source URL, using `referrerpolicy="no-referrer"` so the playground's URL isn't leaked to the third-party host. Your browser contacts that host directly, so it sees your IP. Browsers can't read cross-origin bytes or file sizes without CORS, so the metadata shown for the original (dimensions, format, size) comes from the API's `X-Source-*` headers. Before anything has been processed, or if the browser can't display the image, the UI shows "Unavailable" rather than guessing.

**Processed image.** This is the response `Blob`. Format comes from `Content-Type`, size from `Blob.size`, and dimensions from the decoded image.

**Controls.** They follow API rules: quality is enabled only for JPEG/WebP output, and crop only when both dimensions are set. Non-applicable parameters are left out of the URL.

## Deployment

**Container (API).**

```bash
docker build -t imageflow-api .
docker run --rm -p 3000:3000 -e CORS_ORIGINS=https://playground.example.com imageflow-api
```

The image is a multi-stage build on `node:22-bookworm-slim`. It contains only production dependencies, runs as a non-root user, has a `HEALTHCHECK` on `/health`, and handles SIGTERM gracefully, which suits ECS rolling deploys. On ARM hosts Sharp's prebuilt binary for that architecture is installed automatically.

**UI.** Run `VITE_API_BASE_URL=https://api.example.com npm run build -w apps/web`, then serve `apps/web/dist` from any static host (S3 + CloudFront). Add that origin to `CORS_ORIGINS`.

**Suggested AWS shape** (not implemented; none of it is needed at this scope):

- **ECS Fargate** behind an ALB runs the container. Set `TRUST_PROXY=1` there, because the ALB is the one trusted proxy hop. Scale on CPU, since Sharp is CPU-bound.
- **CloudFront** in front of the ALB, keyed on the full query string, serves most repeat traffic from the edge and makes per-instance caches matter far less.
- **AWS WAF** on CloudFront/ALB provides distributed rate limiting and bot filtering. The in-process limiter remains a per-instance backstop.
- **S3** stores processed images durably, keyed by a hash of the cache key, if regenerating them becomes expensive.
- **CloudWatch** collects the structured JSON logs (request IDs included) and alarms on 5xx rate, p95 latency, `SERVICE_BUSY` counts and memory.
- **Egress control:** run tasks in private subnets with a NAT gateway and security groups that deny VPC-internal egress. This is defense in depth if the application-level SSRF checks ever regress.

## Architectural trade-offs

- **Fastify over Express.** Fastify has built-in Pino structured logging with request IDs, `inject()` for fast HTTP-level tests without opening ports, first-class async error handling, a maintained rate-limit plugin, and better throughput. Express would need extra middleware for most of these.
- **Sharp.** Sharp binds libvips, which streams and is fast and memory-efficient. It has prebuilt binaries, a pixel-limit guard, and correct EXIF orientation and ICC handling. Pure-JS libraries such as Jimp are much slower and use more memory. ImageMagick has a larger attack surface and needs a separate binary.
- **React + Vite.** This is the team's stack. Vite gives instant dev startup and a plain static bundle with no SSR server to operate. The playground has no SEO or server-rendering needs, so Next.js would add complexity without benefit.
- **Monorepo (npm workspaces).** It gives one install, one lint/format/TS config, and one `npm run dev`. The apps share no runtime code, so the API stays fully independent of the UI. Workspaces suffice; Nx and Turborepo would add tooling without a payoff at this size.
- **In-memory cache.** Single instance, zero operational cost, bounded by bytes and entries. A CDN is the better shared cache than Redis for this workload (see [Caching](#caching)).
- **Rejecting redirects.** Following redirects safely means re-running the full URL and DNS policy on each hop, tracking hop counts, and handling scheme downgrades. Each of those is a place for a bypass. Rejecting is simple to audit, and most image URLs don't redirect. Clients can resolve the final URL themselves.
- **No database.** No state needs to outlive a process: there are no users, no saved transforms, and nothing to audit. The cache is ephemeral by design.
- **No queues or async processing.** Each job is bounded (10 MB, 20 MP, 10 s fetch) and finishes within one HTTP request. A queue adds latency, infrastructure and a polling API without improving the user experience. It would make sense for long-running work (video, large batches) or for absorbing large spikes. Here, the concurrency cap plus fast 503s give clean backpressure, and autoscaling handles load.
- **Why rate limiting matters.** Every request can make the server download 10 MB and burn CPU on decoding. Without limits, a single client could exhaust bandwidth and CPU, or use the service to hammer third-party hosts. The concurrency cap protects memory, and the rate limit protects fairness.
- **Evolving for higher traffic.** In rough order of impact:
  1. CDN in front.
  2. Horizontal scaling on Fargate.
  3. WAF for distributed limits.
  4. Single-flight deduplication of identical in-flight requests.
  5. S3 for processed output.
  6. Moving Sharp work to worker threads or a separate pool if event-loop latency suffers.

## Known limitations

- **Rate limiting and cache are per process.** They are correct for one instance, not shared across a fleet.
- **No request coalescing.** N simultaneous identical cache misses cause N fetches.
- **Stale sources** are served until the TTL expires; there is no purge or revalidation.
- **Redirecting sources fail**, by design.
- **Port 443 only.** Images on other HTTPS ports can't be fetched.
- **Upscaling is permitted.** Small images can be enlarged up to the output limits.
- **Animated WebP** is reduced to its first frame.
- **Output color space.** The output is sRGB and the ICC profile is stripped along with the other metadata.
- **No signed URLs or API keys.** Anyone who can reach the service can use it, subject to rate limits.
- **Docker image not verified in this environment.** The Docker daemon wasn't running in the development environment, so the `Dockerfile` was written but not test-built there. `npm run build` and `npm start` were verified.

## What I would improve with more time

- **Single-flight** deduplication of concurrent identical misses.
- **Signed URLs** (HMAC over the query), so only trusted clients can generate transformations. This is the standard defense against cache-busting abuse.
- **Optional domain allow-list** for deployments that only process images from known origins.
- **Metrics:** Prometheus/CloudWatch EMF counters for cache hit rate, error codes, and fetch and process latency.
- **`ETag` / conditional requests**, plus an OpenAPI spec generated from the Zod schema.
- **Redirect following** (up to 3 hops) with per-hop revalidation, if real-world sources need it.
- **Playwright smoke test** of the UI against a stub API, and a CI workflow running build, lint and test.
