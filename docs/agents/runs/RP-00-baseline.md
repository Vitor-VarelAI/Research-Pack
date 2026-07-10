---
run_id: RP-00-20260710
issue: 3
pr: 4
base_sha: b2b63fd08d862a0e6b4302e9f483f1940badf055
agent_runtime: pi
model_requested: unknown
model_reported: unknown
reasoning_effort: unknown
token_usage: null
prompt_path: null
private_context_consulted: true
private_context_ref: local-files@unknown
status: draft_pr_open
---

## Summary

Started RP-00 from the RP-GOV checkpoint. Added local `node:test` smoke coverage for CLI help, `radar-hn`, and `hn-ai` without paid providers or live HN dependency.

## Files changed

- `package.json`
- `src/hn.ts`
- `tests/cli-smoke.test.ts`
- `tests/fixtures/mock-hn-fetch.ts`
- `docs/agents/STATUS.md`
- `docs/agents/runs/RP-00-baseline.md`

## Decisions

- Added `npm test` as `node --import tsx --test "tests/**/*.test.ts"` to match the project TypeScript/ESM setup and avoid shell-glob footguns.
- Kept CLI smoke tests black-box by spawning the CLI through Node with `tsx`.
- Mocked HN via a test-only `fetch` preload rather than calling the live HN API in tests.
- Added `HN_API_BASE` support in `src/hn.ts` for non-production test isolation while preserving the existing default HN API URL.
- Used a temporary `SCRAPE_AGENT_DATA_DIR` in tests so smoke runs do not touch committed files or private `data/` contents.
- External review approved the PR by comment because formal approval is blocked for same-account PRs; the review noted non-blocking follow-ups for later phases.

## Tests run

Initial baseline before edits:

```bash
node --version
npm --version
git branch --show-current
git status --short
npm ci
npm run build
npm run typecheck
bash -n scripts/*.sh
node dist/cli.js --help
node dist/cli.js radar-hn --top 1 --limit 1
node dist/cli.js hn-ai --top 1 --limit 1 --neighbors 1
```

After edits:

```bash
npm ci
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## Results

All listed commands passed locally. The initial live HN smoke commands used small, non-paid HN API requests and wrote only ignored local `data/runs` state. Automated tests use local fixtures and do not call the network.

External review result: approved by PR comment, with non-blocking notes. The shell glob footgun was fixed in this patch. `HN_API_BASE` direct coverage and broader HTTP behaviour are deferred to RP-05.

## Risks

- Branch protection is not configured yet.
- `npm test` currently covers smoke-level CLI behaviour only; deeper source gate, provenance, crawl, radar validation and cost-control tests belong to later phases.
- `HN_API_BASE` is an intentionally small test seam; future HTTP centralization in RP-05 may replace it and should add direct env-var coverage.
- Tests inherit `process.env` and override only test-critical values; this is acceptable for RP-00 smoke coverage but can be tightened if future tests need stricter environment isolation.

## Remaining work

- Review and merge Draft PR #4 when approved.

## Rollback instructions

Before merge: close the RP-00 PR, delete branch `agent/rp-00-baseline`, and remove local worktree `/home/vitor/projects/Research-Pack-rp-00`. After squash merge: create a revert PR for the RP-00 commit.
