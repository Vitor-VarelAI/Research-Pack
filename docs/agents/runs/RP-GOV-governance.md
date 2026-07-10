---
run_id: RP-GOV-20260710
issue: 1
pr: 2
base_sha: e89a4b47d80a07f2efeddb10ec0c3dafe865a7f3
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

Created the initial governance layer for auditable agent phases before technical implementation begins.

## Files changed

- `.github/ISSUE_TEMPLATE/agent-phase.yml`
- `.github/pull_request_template.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/agents/runs/.gitkeep`
- `docs/agents/runs/RP-GOV-governance.md`
- `docs/agents/prompts/.gitkeep`
- `docs/adr/.gitkeep`

## Decisions

- Split permanent coordination from disposable phase workers.
- Standardized phase flow as Issue -> worktree/branch -> Draft PR -> CI/review -> handoff -> squash merge -> checkpoint tag.
- Chose `unknown` for model metadata when the runtime does not expose exact values.
- Kept private context references metadata-only; no private/personal content is copied into the repo.
- Removed self-referential `head_sha` from the versioned handoff; tested commit SHAs belong in PR/CI metadata.
- Added Research-Pack model routing guidance adapted from the Polymarket routing policy in `docs/agents/PROTOCOL.md`. Kept ignored/local `AGENTS.md` out of the public commit.

## Tests run

```bash
git diff --check
git diff --check origin/main...HEAD
bash -n scripts/*.sh
npm run typecheck
npm run build
```

## Results

All listed commands passed locally after the routing/protocol patch.

## Risks

- GitHub remote governance still needs manual setup: Issues, PRs, protected branch rules and checkpoint tags.
- A separate private context repository has not been configured; until then, private context references remain `local-files@unknown`.

## Remaining work

- Review and merge Draft PR #2 when approved.
- Create GitHub Issues for RP-00 through RP-08 after RP-GOV lands.

## Rollback instructions

Before merge: close the PR, delete branch `agent/rp-minus-1-governance`, and remove any local worktree for this phase. After squash merge: create a revert PR for the RP-GOV governance commit.
