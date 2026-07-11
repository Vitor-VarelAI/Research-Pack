# Agent protocol

This repository is run through auditable phase work. Agents are disposable; Issues, PRs, handoffs, ADRs, commits and tags are durable.

## Roles

### Coordinator

The coordinator is permanent across phases and owns process integrity.

Responsibilities:

1. Inspect the real repository state before each phase.
2. Read local instructions and relevant private context without publishing private content.
3. Create the phase Issue with scope, dependencies and required tests.
4. Create a fresh branch/worktree from the latest `origin/main`.
5. Record base SHA, run ID, branch and model metadata when available.
6. Open or verify the Draft PR.
7. Review handoff, CI, tests, scope and privacy constraints.
8. Approve squash merge only after checks pass.
9. Create a checkpoint tag after merge.
10. Update `docs/agents/STATUS.md`.
11. Remove local worktrees after completion.

The coordinator stops and asks Vitor when local/private instructions conflict with the phase plan in a way that cannot be safely resolved.

### Worker

A worker executes exactly one phase. It receives the Issue, previous handoff, relevant ADRs and files required for that phase.

Worker rules:

- Work only on the assigned branch/worktree.
- Do not broaden scope without coordinator approval.
- Keep decisions and blockers in the Issue or PR.
- Produce a versioned handoff before completion.
- The assigned Issue authorizes pushes only to the assigned branch and updates to the linked Draft PR.
- Never push to `main`, merge, tag or deploy without separate explicit authorization.

## Model routing

The coordinator should spend tokens on orchestration, repository state,
scope control, final judgment and integration. Implementation, review,
linting, comparison and other separable work should be delegated to `pi`
subagents when it is useful.

Rationale:

- Vitor already pays for the relevant API usage through `pi`.
- Subagents let the coordinator do less token-heavy execution work and more
  control work.
- Independent workers can run in parallel, which helps move several project
  slices at once.
- Explicit worker prompts and handoffs keep the process auditable.
- Model choice stays controlled instead of depending on whatever the current
  coordinator runtime happens to be.

Default runtime:

- Use `pi` for workers, reviewers and independent second opinions.
- Do not use Hermes for new work unless Vitor explicitly asks for it.
- Treat prior Hermes instructions in this document or older handoffs as legacy
  context only.
- Record `agent_runtime: pi` and model metadata in handoffs whenever available.

Allowed worker/reviewer models:

- `zai/glm-5.2`
- `deepseek/deepseek-v4-pro`

Do not use OpenGo/OpenCode models, GPT review models, Qwen, Claude/Fable/Opus/
Sonnet, or DeepSeek Flash for this project unless Vitor explicitly changes the
allowed set.

Default routing:

| Role or task | Preferred model |
| --- | --- |
| Coordinator / final phase planning | Current Codex coordinator |
| Default implementation worker | `zai/glm-5.2` via `pi` |
| Bulk/mechanical edits, migrations, data analysis, bug hunts | `deepseek/deepseek-v4-pro` via `pi` |
| Long-context docs or sustained implementation loops | `zai/glm-5.2` via `pi` |
| Taste-heavy prompts, UX, copy or editorial output | `zai/glm-5.2` via `pi`, then coordinator final pass |
| Independent second opinion | `deepseek/deepseek-v4-pro` via `pi` |
| Review gate for non-trivial shipping diffs | `deepseek/deepseek-v4-pro` via `pi` |
| Final arbiter for flagged/high-risk items | Current Codex coordinator, with Vitor decision if needed |

Phase guidance:

- RP-00 to RP-04: historical phases may mention older routing in handoffs; do
  not reuse that routing for new work.
- RP-05 and later: use `pi` workers/reviewers with `zai/glm-5.2` or
  `deepseek/deepseek-v4-pro`.
- Security, cost, credential, process and storage risks require a separate
  `pi` review before coordinator approval.
- Editorial output, prompt quality and public wording changes should get a
  `pi` taste/structure pass when the diff is non-trivial.

Review path:

1. Worker summarizes changed files, test results, risks, and open questions.
2. Coordinator gathers the actual diff.
3. A `pi` reviewer using `deepseek/deepseek-v4-pro` reviews non-trivial
   shipping diffs and returns verdict, flagged sections, concerns and
   escalation recommendation.
4. If flagged or high-risk, run a second focused `pi` pass with the smallest
   needed context: summary, touched files, flagged sections and test output.
5. Taste-sensitive diffs may use `zai/glm-5.2` for structure/voice and
   `deepseek/deepseek-v4-pro` for adversarial review.
6. The handoff must state which review path was used. Do not silently skip
   review.

Pi invocation guidance:

```text
Use a pi worker/reviewer with:
- the exact assigned branch/worktree
- the Issue or task prompt
- relevant handoff(s), ADR(s), and touched files
- explicit model request: zai/glm-5.2 or deepseek/deepseek-v4-pro
```

Hard ban: never use DeepSeek V4 Flash. If a DeepSeek model is needed, use
`deepseek/deepseek-v4-pro`.

## Branch, PR and tag naming

Branches:

```text
agent/rp-gov-governance
agent/rp-00-baseline
agent/rp-01-source-gate
agent/rp-02-provenance
agent/rp-03-crawl-pagination
agent/rp-04-radar-cli
agent/rp-05-resilience-costs
agent/rp-06-vps-security
agent/rp-07-ci-docs
agent/rp-08-research-diagnose
```

PR titles:

```text
RP-XX: <phase title>
```

Checkpoint tags after squash merge:

```text
checkpoint/rp-00-baseline
checkpoint/rp-01-source-gate
```

If a hosting/tooling constraint rejects slash tags, use `rp-00-baseline` style tags.

## Standard phase flow

1. Coordinator opens the phase Issue.
2. Coordinator creates a fresh branch/worktree from current `origin/main`.
3. Worker comments on the Issue with run ID, branch, base SHA and model metadata if available.
4. Worker performs an initial checkpoint and opens/updates a Draft PR.
5. Decisions and blockers are recorded in the Issue or PR.
6. Worker completes implementation, tests and handoff.
7. Coordinator verifies scope, privacy, tests, CI and handoff.
8. Coordinator squash-merges the PR.
9. Coordinator creates a checkpoint tag.
10. Coordinator updates `docs/agents/STATUS.md`.
11. Coordinator removes the local worktree.
12. Next phase starts from updated `main`.

## Local worktree command pattern

```bash
git fetch origin
git worktree add ../Research-Pack-rp-01 -b agent/rp-01-source-gate origin/main
```

Do not use `git reset`, `git checkout --`, `git stash` or destructive cleanup commands as part of this process.

## Handoff format

Each run writes one file under `docs/agents/runs/`.

Metadata block:

```yaml
run_id: RP-01-20260710
issue: 2
pr: 3
base_sha: abc123
tested_sha: def456
agent_runtime: pi
agent_profile: unknown
model_requested: zai/glm-5.2
model_reported: unknown
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/source-gate.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: completed
```

Use `unknown` when the runtime does not expose a value. Do not guess. If a
named `pi` profile is used, such as `Earnest`, record it in `agent_profile`.

Required sections:

```md
## Summary

## Files changed

## Decisions

## Tests run

## Results

## Risks

## Remaining work

## Rollback instructions
```

## Private context

Private MDs may affect architecture, workflow or editorial requirements. A worker may consult them when necessary, but must not quote, copy, summarize personal content, commit them, or add them to logs.

Recommended durable reference is a separate private repository on the VPS. Runs should record only a private context reference such as:

```yaml
private_context_consulted: true
private_context_ref: private-context@<sha>
```

If no private repo exists yet, use:

```yaml
private_context_consulted: true
private_context_ref: local-files@unknown
```

## Protected files and data

Workers must not modify or commit:

- `.env`
- `data/`
- `profiles/editorial/soul.md`
- `profiles/editorial/voice.md`

Workers must not print secrets, tokens, private drafts, paid-provider responses, or personal context. If a secret is exposed, stop and recommend revocation.

## Governance validation

RP-GOV must pass at least:

```bash
git diff --check
git diff --check origin/main...HEAD
bash -n scripts/*.sh
npm run typecheck
npm run build
```

Subsequent phases may add stricter checks. RP-01 must not start until RP-GOV has landed and the coordinator has created the RP-00 phase contract.

## Test policy

Tests must use local mocks. They must not call paid providers such as Firecrawl, DeepSeek, Z.ai, Hugging Face or other remote services unless the phase explicitly allows a non-paid/public call.

Before phase completion, run the commands required by the Issue. When applicable, include:

```bash
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## ADR policy

Create or update an ADR in `docs/adr/` when a phase introduces a decision that future phases must preserve, such as schema contracts, storage layout, retry policy, cache semantics or security posture.

## Rollback

Before merge, rollback is closing the PR and removing the local worktree. After squash merge, create a revert PR from the phase commit. Do not rewrite public history.
