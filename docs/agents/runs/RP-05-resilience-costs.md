---
run_id: RP-05-20260711
issue: 15
pr: 16
base_sha: 3ffafb0d060ed6c5c04be3bbd4b2ee6200cf5277
agent_runtime: codex
model_requested: unknown
model_reported: GPT-5
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/rp-05-resilience-costs.md
private_context_consulted: false
private_context_ref: none
status: pr_ready_external_review_approved
---

## Summary

Implemented RP-05 Firecrawl HTTP resilience and cost controls.

- Fixed #14 by removing top-level `maxAge` from `/agent` payloads while preserving the requested `maxAgeMs` in CLI run input and returned provenance.
- Fixed #10 by mapping unrecognized provider cache strings to `cacheState: "unknown"` while preserving the raw string in `cacheStatus`.
- Added a shared authenticated Firecrawl request helper with per-request timeout, bounded transient-status retries, and consistent error parsing.
- Added ADR-0004 for timeout, retry, `/agent` freshness, cache-state, and non-live-test cost-control semantics.

## Files changed

- `docs/adr/0002-provenance-cache-semantics.md`
- `docs/adr/0004-http-resilience-cost-controls.md`
- `docs/agents/STATUS.md`
- `docs/agents/prompts/rp-05-resilience-costs.md`
- `docs/agents/runs/RP-05-resilience-costs.md`
- `src/providers/firecrawl.ts`
- `tests/firecrawl-http-resilience.test.ts`
- `tests/provenance.test.ts`

## Decisions

- Default Firecrawl request timeout is `30_000ms`, configurable via `FIRECRAWL_REQUEST_TIMEOUT_MS` or provider config.
- Default retry cap is `2` retries (`3` total attempts), configurable via `FIRECRAWL_MAX_RETRIES`.
- Retry base delay defaults to `250ms`, doubles per retry, and is configurable via `FIRECRAWL_RETRY_BASE_DELAY_MS`.
- Only HTTP `408`, `429`, `500`, `502`, `503`, and `504` are retried.
- HTTP `400` and other non-transient statuses are not retried; schema/parse failures are not retried.
- `/agent` does not send `maxAge`; `/scrape`, structured scrape, and crawl `scrapeOptions.maxAge` keep existing behavior.
- Unknown cache-state strings now mean `unknown`, not `fresh`.

## Tests run

```bash
npm ci
npm run typecheck
npm test
npm run build
bash -n scripts/*.sh
git diff --check
```

## Results

- `npm ci`: installed cleanly in the new worktree.
- `npm run typecheck`: passed.
- `npm test`: passed with exit code 0 (`113` tests, `113` pass).
- `npm run build`: passed.
- `bash -n scripts/*.sh`: passed.
- `git diff --check`: passed.

## Risks

- Retrying POST requests can duplicate provider-side work if Firecrawl completed an operation but returned a transient error. The retry cap is intentionally low and documented.
- `/agent` provenance records the requested freshness policy, but Firecrawl may not enforce it internally because top-level `maxAge` is not accepted by that endpoint.
- Timeout is per HTTP request, not a full command deadline. Existing crawl/agent poll deadlines still bound long-running jobs separately.

## External review

- Runtime: `pi` subagent
- Agent type: `Plan`
- Model: `deepseek/deepseek-v4-pro`
- Verdict: `APPROVE`
- Summary: no blocking issues; RP-02 provenance and RP-03 same-origin crawl pagination contracts preserved. Initial coverage notes for transient statuses and env config were addressed with additional tests before final push.

## Remaining work

- After approval, squash merge and tag `checkpoint/rp-05-resilience-costs`.

## Rollback instructions

Before merge: close the RP-05 PR, delete branch `agent/rp-05-resilience-costs`, and remove local worktree `/home/vitor/projects/Research-Pack-rp-05` if abandoned. Do not rewrite public history. After squash merge: create a revert PR for the RP-05 commit.
