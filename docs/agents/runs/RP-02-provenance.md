---
run_id: RP-02-20260710
issue: 7
pr: 8
base_sha: b46ef1ac55c7fa826083732c3959a0c73f0e61b8
agent_runtime: pi
model_requested: zai/glm-5.2
model_reported: unknown
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/rp-02-provenance.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: draft_pr_open_pending_review
---

## Summary

Implemented freshness, cache and provenance semantics and immutable atomic
snapshots for RP-02, on branch `agent/rp-02-provenance` from base
`b46ef1a`. No paid providers were called; all tests use local mocks/fixtures.

Changes:

- Firecrawl scrape payloads include `maxAge` whenever a maxAge value is
  configured (`scrape`, `extract`, `crawl`, `extract-ai`, `agent`).
- Research/fact-check style commands (`extract-ai`, `agent`) default to
  `maxAge: 0` (force fresh). Other content commands use explicit
  `--max-age <ms>` or `SCRAPE_AGENT_DEFAULT_MAX_AGE_MS`, and omit `maxAge`
  when none is configured.
- The maxAge value used is persisted in the run record input and in the
  document `provenance`.
- Each `ScrapedDocument` now carries a `provenance` object distinguishing
  `requestedAt`, `providerTimestamp`, `cacheState`, `cacheStatus`, and the
  `maxAgeMs` used. `fetchedAt` equals `requestedAt` for backwards
  compatibility.
- Cached content is never reported as freshly collected without provenance
  fields showing what happened.
- Each collection of the same URL creates a new immutable snapshot id/file;
  previous raw/markdown versions are no longer overwritten (document ids are
  now unique per collection, not a deterministic URL hash).
- `writeJson` is atomic: serializes to a sibling temp file then renames over
  the target. A failed write cannot leave partial JSON at the target path.
- CLI compatibility preserved: existing commands keep working; `--max-age`
  is optional everywhere and `scrape`/`extract`/`crawl` omit maxAge by
  default.

## Files changed

- `src/types.ts` — added `ProvenanceSchema`/`Provenance`, `ScrapeOptions`,
  `maxAgeMs` to `CrawlOptionsSchema`, required `provenance` on
  `ScrapedDocumentSchema`, `scrape` now accepts `ScrapeOptions`.
- `src/providers/firecrawl.ts` — `maxAge` in scrape/crawl/structured/agent
  payloads; unique snapshot ids per collection; `buildProvenance` + `toDocument`
  populate provider timestamp and cache state from response; agent result
  returns provenance; response schema captures optional `cacheState`/`fromCache`.
- `src/util.ts` — `writeJson` is now atomic (temp file + rename + best-effort
  cleanup on failure).
- `src/cli.ts` — `--max-age` option on `scrape`/`extract`/`crawl`/`extract-ai`/
  `agent`; research commands default to 0; maxAge persisted in run records;
  `summarizeDocument` includes provenance.
- `tests/fixtures/mock-firecrawl-fetch.ts` — local Firecrawl mock that records
  request bodies (no network, no paid providers).
- `tests/provenance.test.ts` — new tests covering maxAge payload, research
  default `maxAge:0`, custom maxAge, distinct snapshot ids/files, provenance
  timestamp/cache distinction, and atomic-write failure safety.
- `docs/adr/0002-provenance-cache-semantics.md` — ADR for cache/provenance
  contract.
- `docs/agents/runs/RP-02-provenance.md` — this handoff.

## Decisions

- `maxAgeMs` in provenance is `number | null`: `0` means "force fresh, maxAge
  sent as 0"; `null` means "maxAge was not sent". This keeps the two cases
  distinguishable rather than collapsing both to `0`.
- Research/fact-check style = `extract-ai` and `agent` (the multi-page and
  structured extraction flows that feed the source gate). They default to
  `maxAge: 0`.
- Document ids changed from `doc_<sha256(url)[:16]>` (deterministic, caused
  overwrites) to `doc_<randomUUID>` (unique per collection). The stored
  filename still embeds the URL slug for visual grouping.
- `fetchedAt` is kept equal to `requestedAt` for backwards compatibility
  rather than removing it; provenance is the source of truth for what
  actually happened.
- The Firecrawl `/agent` endpoint's handling of `maxAge` is best-effort: the
  value is sent in the payload, but the agent's internal page fetches may not
  honour it. This is recorded in the run input and the agent result
  provenance.
- Atomic write uses a sibling temp file + `rename` on the same filesystem;
  on failure the temp file is removed best-effort and the error rethrown.
- Created ADR-0002 because PROTOCOL.md requires an ADR for cache semantics.

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

All commands passed locally.

- `npm test`: 48 tests, 48 pass, 0 fail (was 30 before RP-02; +18 new
  provenance tests).
- `npm run typecheck`: clean (strict + `exactOptionalPropertyTypes`).
- `npm run build`: clean.
- `bash -n scripts/*.sh`: clean.
- `git diff --check`: clean (no whitespace errors).

New coverage (`tests/provenance.test.ts`):

- scrape payload includes `maxAge` when provided; omits it when not.
- custom maxAge forwarded exactly.
- structured scrape (extract-ai) sends `maxAge:0` by default.
- agent sends `maxAge` in payload and returns provenance.
- CLI `extract-ai` / `agent` default to `maxAge:0` in the recorded payload.
- CLI `scrape --max-age` forwards the value into the payload.
- provenance distinguishes `requestedAt` vs `providerTimestamp`; cached vs
  fresh vs unknown; `maxAgeMs` recorded.
- two collections of the same URL produce distinct ids and distinct raw +
  markdown files (no overwrite).
- simulated write failure (read-only dir) leaves the original target intact
  and no `.tmp-` partial file.

## Risks

- The worker wrapped up at the turn limit, so the coordinator independently re-ran the required validation before commit/PR.
- `ScrapedDocumentSchema` now requires `provenance`; any external consumer
  that builds documents without provenance will fail validation. All
  in-repo document producers were updated.
- The Firecrawl `/agent` `maxAge` is best-effort (see Decisions). Future
  phases should verify against the live API whether the agent endpoint
  honours it; tests cannot prove provider behaviour.
- Atomic write relies on `rename` being atomic on the same filesystem. If a
  future data layout puts the temp file on a different filesystem than the
  target, `rename` may fail with EXDEV; RP-05 should keep temp + target on
  the same volume if storage layout changes.
- `SCRAPE_AGENT_DEFAULT_MAX_AGE_MS` is a new, undocumented env var; it is
  optional and only affects `scrape`/`extract`/`crawl`. Not added to
  `.env.example` (workers must not modify `.env`-adjacent expectations
  lightly); follow-up docs phase can document it.

## Remaining work

- External review PR #8 using only allowed models (`zai/glm-5.2` or `deepseek/deepseek-v4-pro`).
- Mark PR ready and merge only after approval.
- Coordinator: update `docs/agents/STATUS.md` after merge.
- Future phases: keep provenance contract intact when adding crawl pagination
  (RP-03) and HTTP resilience/cost controls (RP-05).

## Rollback instructions

Before merge: close the RP-02 PR (if opened), delete branch
`agent/rp-02-provenance`, and remove the local worktree
`/home/vitor/projects/Research-Pack-rp-02` if the branch is abandoned. Do not
rewrite public history. After squash merge: create a revert PR for the RP-02
commit.
