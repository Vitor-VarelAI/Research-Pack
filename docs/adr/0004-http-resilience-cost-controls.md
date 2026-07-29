# ADR-0004: Firecrawl HTTP resilience and cost controls

Status: proposed
Phase: RP-05 (HTTP resilience and cost controls)
Date: 2026-07-11

## Context

RP-04 left the Firecrawl provider with direct `fetch` calls in multiple paths.
The first live `agent` run also showed that `/agent` rejects a top-level
`maxAge` key even though `/scrape` accepts it. Without a shared HTTP contract:

- Firecrawl requests could hang indefinitely at the request level.
- Transient provider failures required manual reruns.
- Retries had no explicit cap, which is a cost risk for paid provider calls.
- `/agent` could keep sending a payload shape known to fail live.
- Unknown cache strings were treated as `fresh`, overstating provenance.

## Decision

### Request timeout

- Every authenticated Firecrawl HTTP request goes through the shared request
  helper.
- Default per-request timeout is `30_000ms`.
- Timeout can be configured with `FIRECRAWL_REQUEST_TIMEOUT_MS` or provider
  config in tests.
- Invalid timeout config fails before a request is made.

### Retry policy

- The provider retries only transient HTTP statuses: `408`, `429`, `500`,
  `502`, `503`, and `504`.
- Default retry cap is `2` retries, meaning at most `3` attempts total.
- Retry cap can be configured with `FIRECRAWL_MAX_RETRIES`.
- Retry base delay defaults to `250ms`, doubles per retry, and can be configured
  with `FIRECRAWL_RETRY_BASE_DELAY_MS`.
- Non-transient errors such as `400` are not retried.
- Schema/parse failures are not retried.

### Agent freshness

- `/scrape` and structured scrape continue to send `maxAge` when configured.
- `/crawl` continues to send `maxAge` inside `scrapeOptions`.
- `/agent` no longer sends top-level `maxAge` because Firecrawl rejects that
  payload shape. The CLI still records the requested `maxAgeMs` in the run input
  and the returned provenance so the operator can see the intended freshness
  policy.

### Cache provenance

- Recognized cache strings map as:
  - `hit` / `cached` -> `cached`
  - `miss` / `fresh` -> `fresh`
- Any other provider cache string maps to `unknown` while preserving the raw
  string in `cacheStatus`.

### Test and cost policy

- RP-05 tests use local fetch mocks only.
- No paid Firecrawl, DeepSeek, Z.ai, or other provider calls are allowed in
  validation.
- Future live verification of credit semantics must be explicit and operator
  authorized.

## Consequences

- Retrying POST requests can duplicate provider-side work if the provider did
  perform the operation before returning a transient error. The retry cap is
  intentionally low and documented as a cost control.
- Callers get consistent `Firecrawl <status>: <message>` errors across scrape,
  map, crawl, structured scrape, and agent flows.
- Future phases must keep the RP-03 same-origin guard before following
  provider-supplied URLs.
- RP-06 should treat these environment variables as operational config, not
  secrets.
