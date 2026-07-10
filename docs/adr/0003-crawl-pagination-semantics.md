# ADR-0003: Crawl pagination and cost-metadata semantics

Status: proposed
Phase: RP-03 (Crawl pagination)
Date: 2026-07-10

## Context

RP-02 defined freshness/cache/provenance semantics for single-page scrapes,
but the Firecrawl crawl flow only consumed the first page of a crawl status
response. Firecrawl crawl status responses may expose a `next` URL to fetch
additional pages of results, plus cost/duration/timestamp metadata
(`creditsUsed`, `durationMs`, `startedAt`, `finishedAt`, `expiresAt`). Before
RP-03:

- A `next` page URL returned by the provider was never followed, so large
  crawls silently returned only the first page of documents.
- Credits, duration and provider timestamps exposed on the crawl status
  response were discarded.
- The crawl provider sent the bearer token to any URL it fetched, so a
  provider-supplied (or attacker-influenced) `next` could redirect the
  credential to another origin.

## Decision

### Pagination

- `FirecrawlCrawlStatusResponseSchema` now accepts optional `next`,
  `creditsUsed`, `durationMs`, `startedAt`, `finishedAt`, and `expiresAt`
  fields.
- After the crawl job reaches a terminal status, the provider follows every
  valid `next` page and aggregates all documents into the result.
- `next` may be relative or absolute. Relative URLs are resolved against the
  Firecrawl base URL with the standard `URL` resolution semantics.
- Before issuing an authenticated request to a provider-supplied `next`, the
  provider resolves it and asserts same-origin (protocol + host + port) with
  the base URL. Cross-origin `next` URLs are rejected with an error and the
  bearer token is never sent to the other origin.
- A safety cap of 1000 pagination pages guarantees termination even if a page
  returns zero documents but still carries a `next`.

### Cost metadata

- The provider returns a `CrawlResult` (not a bare `ScrapedDocument[]`)
  carrying `documents`, `pages`, `creditsUsed`, `durationMs`, `startedAt`,
  `finishedAt`, and `expiresAt`.
- Firecrawl reports `creditsUsed` and `durationMs` cumulatively per status
  response, so the last non-null value seen across pages is preserved (not
  summed). Timestamps are likewise the last non-null value seen.
- All metadata fields are `null` when the provider did not report them.
- The CLI `crawl` command preserves these fields in both its stdout output
  and the persisted run record.

### Compatibility

- The CLI `crawl` command keeps its existing arguments and still saves every
  aggregated document. Its output gains additive metadata fields; no existing
  field is removed or renamed.
- `CrawlProvider.crawl` return type changed from `Promise<ScrapedDocument[]>`
  to `Promise<CrawlResult>`. The CLI is the only in-repo consumer and was
  updated. The provenance contract from ADR-0002 is preserved on every
  aggregated document.

## Consequences

- External consumers of `CrawlProvider.crawl` must read `result.documents`
  instead of the array directly. This is an intentional interface change
  scoped to RP-03.
- The cross-origin guard is a security control: future phases must not bypass
  `assertSameOrigin` when following provider-supplied URLs, and must not
  attach the bearer token to a URL before validating its origin.
- Cumulative-vs-per-page credit accounting is an assumption about Firecrawl's
  API. If a future Firecrawl version reports per-page credits, the
  preservation logic (last non-null value) will undercount. RP-05 (cost
  controls) should verify against the live API and switch to summation if
  needed.
- Relative `next` URLs follow standard URL resolution: an absolute-path
  relative URL (e.g. `/crawl/...`) resolves against the base origin and may
  drop the `/v2` base path. Firecrawl is expected to return either
  same-origin absolute URLs or path-relative URLs that include the version
  segment.
