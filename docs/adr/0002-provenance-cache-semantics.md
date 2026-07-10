# ADR-0002: Freshness, cache and provenance semantics

Status: proposed
Phase: RP-02 (Freshness, cache and provenance)
Date: 2026-07-10

## Context

RP-01 introduced the source sufficiency gate but did not define how scraped
content is cached, how fresh it must be, or how to prove where a given
document came from. Without explicit freshness/provenance semantics:

- Repeated scrapes of the same URL silently overwrote previous raw/markdown
  snapshots (document ids were a deterministic hash of the URL).
- Firecrawl could serve cached content that was then recorded as collected
  "now", with no field distinguishing requested time, provider time, or cache
  state.
- There was no way to force fresh collection for research/fact-check flows.
- JSON writes were not atomic; a failed write could leave a partial file.

## Decision

### maxAge

- Firecrawl scrape payloads include `maxAge` whenever a maxAge value is
  configured.
- Research/fact-check style commands (`extract-ai`, `agent`) default to
  `maxAge: 0` (force fresh, never accept cache). Overridable via `--max-age`.
- Other content commands (`scrape`, `extract`, `crawl`) use an explicit,
  configurable maxAge via `--max-age <ms>`, falling back to
  `SCRAPE_AGENT_DEFAULT_MAX_AGE_MS` if set, and omitting `maxAge` from the
  payload entirely when no value is configured.
- `map`, `radar-hn`, and `hn-ai` do not collect page content and do not send
  maxAge.
- The maxAge value used is persisted in the run record input and in the
  document `provenance`.

### Provenance

Every `ScrapedDocument` now carries a `provenance` object:

```ts
{
  requestedAt: string;        // ISO when WE issued the request (== fetchedAt)
  maxAgeMs: number | null;    // maxAge sent (0 = force fresh, null = not sent)
  providerTimestamp: string | null; // scrapedAt/fetchedAt from provider metadata
  cacheState: "fresh" | "cached" | "unknown";
  cacheStatus: string | null; // raw cache indicator from provider
}
```

`fetchedAt` is kept equal to `requestedAt` for backwards compatibility, but
cached content is never reported as freshly collected without these fields
showing what happened. The Firecrawl scrape response schema captures optional
`cacheState` / `fromCache` fields and `metadata.scrapedAt`.

### Immutable snapshots

Document ids are now unique per collection (`doc_<randomUUID>`), never a
deterministic hash of the URL. The stored filename still embeds the URL slug
for visual grouping, but the id suffix differs per collection. Repeated
scrapes of the same URL therefore create new raw/markdown files and never
overwrite previous snapshots.

### Atomic JSON writes

`writeJson` serializes to a sibling temp file then `rename`s it over the
target. A write failure or crash cannot leave partial JSON at the target
path; the temp file is removed best-effort on failure.

## Consequences

- `ScrapedDocumentSchema` now requires `provenance`. All document-producing
  provider paths populate it.
- Document ids are no longer stable across collections of the same URL; code
  that assumed deterministic ids per URL must use the URL slug instead.
- Future phases (RP-03 crawl, RP-05 resilience/costs) must preserve the
  provenance contract and the atomic-write guarantee when adding storage or
  retry behaviour.
- The Firecrawl `/agent` endpoint's handling of `maxAge` is best-effort:
  the value is sent in the payload, but the agent's internal page fetches
  may not honour it. This is recorded in the agent run input and result
  provenance.
