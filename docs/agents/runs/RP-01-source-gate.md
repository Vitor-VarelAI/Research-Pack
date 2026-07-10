---
run_id: RP-01-20260710
issue: 5
pr: 6
base_sha: 437afc76eab5a2315e0017ec66eaaa43cc484f99
agent_runtime: hermes
model_requested: glm-5.2
model_reported: unknown
reasoning_effort: unknown
token_usage: null
prompt_path: docs/agents/prompts/rp-01-source-gate.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: changes_requested_fix_validated
---

## Summary

Hermes was delegated RP-01 implementation with a written prompt. The Hermes process did not return a final narrative before timeout, so the diff is treated as worker-produced but untrusted until coordinator validation and external review. Coordinator inspected the resulting files and ran the required local checks.

The implementation adds a canonical source sufficiency gate schema, CLI validation command, `content-qa.sh` gate enforcement before linters, local tests, and deprecates single-page `extract-ai --schema fact-check` with a migration message.

## Files changed

- `docs/agents/STATUS.md`
- `docs/agents/prompts/rp-01-source-gate.md`
- `docs/agents/runs/RP-01-source-gate.md`
- `prompts/fact-check.md`
- `scripts/content-qa.sh`
- `src/cli.ts`
- `src/schemas/fact-check.ts`
- `src/schemas/source-gate.ts`
- `tests/cli-smoke.test.ts`
- `tests/content-qa-gate.test.ts`
- `tests/fixtures/source-gate-fixtures.ts`
- `tests/source-gate.test.ts`

## Decisions

- Created `src/schemas/source-gate.ts` as the canonical source sufficiency gate contract.
- After external review, enforced derived invariants inside `SourceGateResultSchema`: `minimumAnchorsFound === anchors.length`, `needsExtraAnchor === sensitiveCategories.length > 0`, `pass === derived threshold result`, and `diagnosisAllowed === pass`.
- Kept the gate explicitly scoped to source sufficiency, not factual verification.
- Added `scrape-agent source-gate --validate <file>` so shell scripts can validate JSON/schema/pass/diagnosisAllowed through the TypeScript/Zod contract.
- Added `SOURCE_GATE_RESULT_FILE` and `SCRAPE_AGENT_BIN` test seams for `content-qa.sh` so tests can prove gate blocking without paid providers.
- Deprecated `extract-ai --schema fact-check` for single-page usage with a migration message to `agent` or future `research`.

## Tests run

```bash
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## Results

All listed commands passed locally after the Hermes-produced partial diff.

External review requested changes because the first validation path trusted LLM-reported `pass`, `diagnosisAllowed`, `needsExtraAnchor`, and `minimumAnchorsFound`. The follow-up patch now enforces those values as schema invariants and adds adversarial tests for forged pass results. The same validation command set passed after this fix.

## Risks

- Hermes did not provide a final handoff, so the implementation needs external reviewer scrutiny before merge.
- The source gate validates source-count and schema semantics; it does not verify factual truth.
- `content-qa.sh` now shells through a CLI command for gate validation; external review considered this acceptable once schema invariants are enforced.

## Remaining work

- Push external-review fixes to PR #6.
- Request re-review before marking ready/merge.

## Rollback instructions

Before merge: close the RP-01 PR, delete branch `agent/rp-01-source-gate`, and remove local worktree `/home/vitor/projects/Research-Pack-rp-01`. After squash merge: create a revert PR for the RP-01 commit.
