---
run_id: RP-04-20260710
issue: 12
pr: 13
base_sha: 34c0e75b64dfbc05360904d9eb892b220d3955fd
agent_runtime: pi
model_requested: zai/glm-5.2
model_reported: unknown
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/rp-04-radar-cli.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: draft_pr_open_pending_review
---

## Summary

Implemented RP-04 radar signal fixes, strict CLI integer validation, and HN request concurrency limiting. The worker subagent hit the turn limit before a full handoff, so the coordinator inspected the diff, fixed one failing radar sorting test, added an extra env validation check, and re-ran the required validation.

## Files changed

- `docs/agents/STATUS.md`
- `docs/agents/prompts/rp-04-radar-cli.md`
- `docs/agents/runs/RP-04-radar-cli.md`
- `src/cli.ts`
- `src/hn.ts`
- `src/radar.ts`
- `tests/cli-integer-validation.test.ts`
- `tests/fixtures/mock-fetch-throw.ts`
- `tests/hn-concurrency.test.ts`
- `tests/radar.test.ts`

## Decisions

- Replaced permissive integer parsing with full-string non-negative integer parsers and per-option maximums.
- Kept zero valid only where it has a defined meaning (`--max-age 0`, `--wait-for 0`, `--neighbors 0`). Count/limit options require at least 1.
- Added HN item-request concurrency cap with default 8 and env override `HN_CONCURRENCY`, clamped/validated to avoid accidental unbounded requests.
- Added word-boundary matching for short radar acronyms (`UI`, `UX`, `API`, `app`, `OS`, `EU`, `US`, `PR`) to avoid substring false positives.
- Exported `detectRadarSignals` for pure radar tests.
- Filtered radar report items by at least one detected signal rather than totalScore alone; otherwise a high-rank but signal-less story could enter via rank/score-derived novelty.

## Tests run

```bash
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## Results

All listed commands passed locally after the coordinator fix.

- `npm test`: 99 tests, 99 pass, 0 fail.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `bash -n scripts/*.sh`: clean.
- `git diff --check`: clean.

## Risks

- The worker subagent aborted at max turns, so the coordinator had to complete final validation and one small fix.
- Radar matching still uses regex rules rather than a full tokenizer; RP-04 covers the known false-positive classes but future domain-specific false positives may need additional targeted rules.
- HN concurrency env override falls back to default on invalid values instead of failing the command; CLI integer options fail hard before requests.

## Remaining work

- External review PR #13 using only allowed models (`zai/glm-5.2` or `deepseek/deepseek-v4-pro`).
- Mark ready/merge only after approval.

## Rollback instructions

Before merge: close the RP-04 PR, delete branch `agent/rp-04-radar-cli`, and remove local worktree `/home/vitor/projects/Research-Pack-rp-04` if the branch is abandoned. Do not rewrite public history. After squash merge: create a revert PR for the RP-04 commit.
