# RP-01 worker prompt — Source gate and fact-check contract

You are the implementation worker for Issue #5 in `Vitor-VarelAI/Research-Pack`.

Repository worktree:

```text
/home/vitor/projects/Research-Pack-rp-01
```

Branch:

```text
agent/rp-01-source-gate
```

Base SHA:

```text
437afc76eab5a2315e0017ec66eaaa43cc484f99
```

## Must read before editing

- `AGENTS.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/agents/runs/RP-GOV-governance.md`
- `docs/agents/runs/RP-00-baseline.md`
- GitHub Issue #5 text if available

Do not reveal or copy private/personal content. Do not modify `.env`, `data/`, `profiles/editorial/soul.md`, or `profiles/editorial/voice.md`.

## Goal

Create one canonical Zod-backed source sufficiency gate contract and enforce it before content QA/factual/editorial linters run.

This is a source sufficiency gate, not a full factual-verification system. Make that distinction explicit in names, messages, or docs/comments where appropriate.

## Required behaviour

- A result with 0-2 source anchors is valid JSON but must have:
  - `pass: false`
  - `diagnosisAllowed: false`
- A non-sensitive topic may pass with at least 3 valid source anchors.
- Sensitive topics require at least 4 valid source anchors.
- Sensitive categories are the project-defined ones: privacy, copyright, security, financial claims, benchmarks, legal claims, superlatives.
- `content-qa.sh` must validate JSON and stop immediately if:
  - source-gate output is invalid JSON;
  - schema validation fails;
  - `pass` is false;
  - `diagnosisAllowed` is false.
- When the gate blocks, downstream linters must not run.
- When the gate approves, downstream linters must run.
- Remove or deprecate `extract-ai --schema fact-check` for single-page usage with a clear migration message to `agent` or future `research`.
- Preserve current command compatibility except where the Issue explicitly asks for migration/deprecation.

## Required tests

Use local fixtures/mocks only. Do not call Firecrawl, DeepSeek, Z.ai, Hugging Face, or paid providers.

Cover:

- invalid source-gate JSON fails;
- two sources block;
- three valid sources pass for non-sensitive topics;
- sensitive topic requires four;
- `pass:false` prevents linters;
- approved gate executes linters;
- CLI and script schemas are compatible;
- `extract-ai --schema fact-check` single-page usage has the expected migration/deprecation behaviour.

Run before handing back:

```bash
npm ci
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

## Handoff

Create/update:

```text
docs/agents/runs/RP-01-source-gate.md
```

Include metadata, summary, files changed, decisions, tests and results, risks, remaining work, rollback instructions. Be truthful about model/runtime. If unknown, write `unknown`.

## Output to coordinator

When done, report:

- changed files;
- tests run and result;
- any migrations/compatibility decisions;
- risks;
- whether the branch is ready for external review.
