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

The goal is to use the cheapest model that can reliably meet the bar, while protecting premium quota for decisions where quality or risk matters.

Default routing:

| Role or task | Preferred model |
| --- | --- |
| Coordinator / final phase planning | `fable-5` or `opus-4.8` |
| Default implementation worker | `glm-5.2` |
| Bulk/mechanical edits, migrations, data analysis, bug hunts | `deepseek-v4-pro` |
| Long-context docs or sustained implementation loops | `minimax-m3` |
| Taste-heavy API naming, prompts, UX, copy, editorial output | `kimi-k2.6` |
| Independent second opinion | `qwen3.7-max` |
| First-pass review gate for non-trivial shipping diffs | `gpt-5.5` |
| Final arbiter for flagged/high-risk items | `fable-5` or `opus-4.8` |

Phase guidance:

- RP-00 to RP-04: `glm-5.2` or `deepseek-v4-pro` may implement; `gpt-5.5` reviews non-trivial diffs.
- RP-05 and RP-06: `gpt-5.5` review is mandatory; escalate security, cost, credential, process, and storage risks to `fable-5` or `opus-4.8`.
- RP-07: medium-cost models are acceptable, but CI and metadata changes still need review.
- RP-08: use a strong implementation model plus taste/editorial review with `kimi-k2.6`, `fable-5`, or `opus-4.8` when output format, prompt quality, or public wording changes.

Review path:

1. Worker summarizes changed files, test results, risks, and open questions.
2. Coordinator gathers the actual diff.
3. `gpt-5.5` reviews non-trivial shipping diffs and returns verdict, flagged sections, concerns, and escalation recommendation.
4. If flagged or high-risk, `fable-5` or `opus-4.8` reviews only the summary, flagged sections, touched file list, and test output unless more context is needed.
5. Taste-sensitive diffs may skip GPT first-pass and go directly to `kimi-k2.6`, `fable-5`, or `opus-4.8`.
6. The handoff must state which review path was used. Do not silently skip review.

Hermes invocation pattern from this repo:

```bash
hermes -z "<task prompt>" -m <model> --cwd /home/vitor/projects/scrape-agent
```

For true per-task routing, spawn a separate Hermes child process with an explicit `-m <model>` flag. Do not rely on delegation mechanisms that inherit the parent model when the task requires a specific model.

Hard ban: never use DeepSeek V4 Flash. If a DeepSeek model is needed, use `deepseek-v4-pro`.

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
agent_runtime: codex
model_requested: unknown
model_reported: unknown
reasoning_effort: high
token_usage: null
prompt_path: docs/agents/prompts/source-gate.md
private_context_consulted: true
private_context_ref: local-files@unknown
status: completed
```

Use `unknown` when the runtime does not expose a value. Do not guess.

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
