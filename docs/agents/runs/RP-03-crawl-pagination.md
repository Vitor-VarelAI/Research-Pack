---
run_id: RP-03-20260710
issue: 9
pr: 11
base_sha: d9e39ba31b5bf99bf6cc6e287f50ba40bb07f98a
agent_runtime: pi
model_requested: zai/glm-5.2
model_reported: unknown
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/rp-03-crawl-pagination.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: draft_pr_open_pending_review
---

## Summary

Implemented safe Firecrawl crawl pagination and preserved pagination/cost
metadata on branch `agent/rp-03-crawl-pagination` from base `d9e39ba`. No
paid providers were called; all tests use local in-process fetch mocks and
fixtures.

Changes:

- `FirecrawlCrawlStatusResponseSchema` now accepts optional `next`,
  `creditsUsed`, `durationMs`, `startedAt`, `finishedAt`, and `expiresAt`
  fields.
- After the crawl job reaches a terminal status, the provider follows every
  valid `next` page and aggregates all documents into the result.
- `next` may be relative (resolved against the Firecrawl base URL via standard
  `URL` semantics) or absolute same-origin.
- Cross-origin `next` URLs are rejected with an error BEFORE any
  authenticated request, so the bearer token is never sent to another origin.
- A 1000-page safety cap guarantees termination even if a page returns zero
  documents with a `next`.
- The provider now returns a `CrawlResult` (`documents` + `pages` +
  `creditsUsed`/`durationMs`/`startedAt`/`finishedAt`/`expiresAt`) instead of
  a bare `ScrapedDocument[]`. Cumulative fields (`creditsUsed`, `durationMs`)
  preserve the last non-null value seen across pages (Firecrawl reports them
  cumulatively), not a sum.
- The CLI `crawl` command keeps its existing arguments and still saves every
  aggregated document; its stdout and the persisted run record gain additive
  metadata fields. Provenance (ADR-0002) is preserved on every aggregated
  document.
- Created ADR-0003 documenting the pagination/cost-metadata contract and the
  cross-origin security control.

## Files changed

- `src/types.ts` — added `CrawlResult` type; `CrawlProvider.crawl` now
  returns `Promise<CrawlResult>`.
- `src/providers/firecrawl.ts` — extended crawl status schema with
  `next`/`creditsUsed`/`durationMs`/`startedAt`/`finishedAt`/`expiresAt`;
  `request` now accepts a path or full absolute URL; added `pollCrawlStatus`,
  `resolveNextUrl`, `assertSameOrigin` helpers; `crawl` follows `next`,
  validates same-origin, aggregates documents, preserves metadata, enforces
  1000-page cap, returns `CrawlResult`.
- `src/cli.ts` — `crawl` command consumes `CrawlResult` and writes
  `pages`/`creditsUsed`/`durationMs`/`startedAt`/`finishedAt`/`expiresAt`
  into both stdout and the run record.
- `tests/fixtures/mock-firecrawl-fetch.ts` — added a fixed two-page crawl
  mock (same-origin absolute `next`) plus credits/timestamps for CLI tests.
- `tests/crawl-pagination.test.ts` — new: 11 tests covering all required
  cases (one page, multiple pages, absolute same-origin `next`, relative
  `next`, cross-origin rejected + token not sent, malformed paginated
  responses, credits/duration/timestamps preserved, provenance on aggregated
  documents, CLI compatibility + run-record metadata).
- `docs/adr/0003-crawl-pagination-semantics.md` — ADR for the pagination/
  cost-metadata contract and cross-origin guard.
- `docs/agents/runs/RP-03-crawl-pagination.md` — this handoff.

## Decisions

- `CrawlProvider.crawl` return type changed from `Promise<ScrapedDocument[]>`
  to `Promise<CrawlResult>`. The CLI is the only in-repo consumer and was
  updated. This is an intentional interface change scoped to RP-03, required
  to preserve cost metadata.
- Cross-origin `next` is rejected before any authenticated fetch. The bearer
  token is attached unconditionally inside `request`, so origin validation is
  enforced at the `next`-following call site (`assertSameOrigin`) before
  `request` is invoked. Future phases must not bypass this for
  provider-supplied URLs.
- `creditsUsed` and `durationMs` are preserved as the last non-null value
  seen across pages (Firecrawl reports them cumulatively per status
  response), not summed. Timestamps likewise use the last non-null value.
- Relative `next` URLs follow standard `URL` resolution against the base URL.
  An absolute-path relative URL (e.g. `/crawl/...`) resolves against the
  base origin and may drop the `/v2` base path; Firecrawl is expected to
  return same-origin absolute URLs or version-prefixed relative URLs.
- 1000-page pagination cap is an internal safety guard (not CLI-exposed) to
  guarantee termination; it does not change the document `limit`.
- Created ADR-0003 because PROTOCOL.md requires an ADR for security posture
  and schema contracts.

## Tests run

```bash
npm ci
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## Results

All commands passed locally in the worker run and again in coordinator validation before commit/PR.

- `npm test`: 59 tests, 59 pass, 0 fail (was 48 before RP-03; +11 new crawl
  pagination tests).
- `npm run typecheck`: clean (strict + `exactOptionalPropertyTypes`).
- `npm run build`: clean.
- `bash -n scripts/*.sh`: clean.
- `git diff --check`: clean (no whitespace errors).

New coverage (`tests/crawl-pagination.test.ts`):

- one page without `next` returns the single page's documents, `pages === 1`.
- multiple pages: follows `next`, aggregates documents, `pages === 2`, `next`
  fetched exactly once.
- absolute same-origin `next` is followed.
- relative `next` is resolved against the base URL and followed.
- cross-origin `next` is rejected with a `cross-origin` error and no request
  is issued to the evil origin (bearer token not sent cross-origin).
- malformed paginated response: non-2xx page throws `Firecrawl 500`;
  `success:false` body throws the provider error; unresolvable `next` URL
  throws.
- credits/duration/timestamps preserved: `creditsUsed`, `durationMs`,
  `startedAt`, `finishedAt`, `expiresAt` carried through (cumulative
  last-value semantics).
- provenance preserved on every aggregated document; distinct snapshot ids
  across pages (no overwrite).
- CLI `crawl` command compatibility: exits 0, returns `count === 2`,
  `documents.length === 2`, and writes `pages`/`creditsUsed`/`durationMs`/
  timestamps into both stdout and `runs.jsonl`.

## Risks

- Cumulative-vs-per-page credit accounting is an assumption about Firecrawl's
  API. If a future Firecrawl version reports per-page credits, the
  last-non-null preservation will undercount. RP-05 (cost controls) should
  verify against the live API and switch to summation if needed.
- The cross-origin guard is the security control for credential safety; it
  must not be bypassed by future code that follows provider-supplied URLs.
  The bearer token is attached inside `request` unconditionally, so origin
  validation MUST happen at the call site before `request`.
- Relative `next` resolution follows standard URL semantics: an
  absolute-path relative URL drops the `/v2` base path. This is correct URL
  behavior but depends on Firecrawl returning appropriately-scoped `next`
  URLs. Not verifiable without the live API.
- The 1000-page cap is a guard, not a configured limit; a legitimate crawl
  returning >1000 non-empty pagination pages would error. Unlikely given
  `limit` caps at 1000 documents.
- `CrawlProvider.crawl` return type changed; any external consumer of the
  provider interface must now read `result.documents`.

## Remaining work

- External review PR #11 using only allowed models (`zai/glm-5.2` or
  `deepseek/deepseek-v4-pro`). Do not use OpenGo/OpenCode models.
- Mark PR ready and merge only after approval.
- Coordinator: update `docs/agents/STATUS.md` after merge.
- Future phases: keep the cross-origin guard and provenance contract intact
  when adding HTTP resilience/cost controls (RP-05). RP-05 should verify
  Firecrawl's cumulative credit reporting against the live API.

## Rollback instructions

Before merge: close the RP-03 PR (if opened), delete branch
`agent/rp-03-crawl-pagination`, and remove the local worktree
`/home/vitor/projects/Research-Pack-rp-03` if the branch is abandoned. Do not
rewrite public history. After squash merge: create a revert PR for the RP-03
commit.
