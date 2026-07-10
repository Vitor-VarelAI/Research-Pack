# RP-02 worker prompt — Freshness, cache and provenance

You are the implementation worker for Issue #7 in `Vitor-VarelAI/Research-Pack`.

Repository worktree:

```text
/home/vitor/projects/Research-Pack-rp-02
```

Branch:

```text
agent/rp-02-provenance
```

Base SHA:

```text
b46ef1ac55c7fa826083732c3959a0c73f0e61b8
```

## Model policy

You must be running on `zai/glm-5.2` or `deepseek/deepseek-v4-pro`. Do not use OpenGo/OpenCode models. Do not use DeepSeek V4 Flash.

## Must read before editing

- `AGENTS.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/agents/runs/RP-GOV-governance.md`
- `docs/agents/runs/RP-00-baseline.md`
- `docs/agents/runs/RP-01-source-gate.md`
- Issue #7 text if available

Do not reveal or copy private/personal content. Do not modify `.env`, `data/`, `profiles/editorial/soul.md`, or `profiles/editorial/voice.md`.

## Goal

Implement freshness/cache/provenance semantics and immutable atomic snapshots.

## Required behaviour

- Firecrawl scrape payloads include `maxAge` where applicable.
- Research/fact-check style collection uses `maxAge: 0` by default.
- Other commands use explicit configurable `maxAge` where appropriate.
- Persist/log the `maxAge` value used.
- Distinguish:
  - `requestedAt`
  - provider timestamp if present
  - cache state/status if present
- Do not mark cached content as collected "now" without provenance fields showing what happened.
- Each collection of the same URL creates a new immutable snapshot ID/file.
- Do not overwrite previous raw/markdown versions for repeated same-URL collections.
- JSON writes are atomic; simulated write failure must not leave partial JSON.
- Preserve current CLI compatibility as much as possible.

## Required tests

Use local mocks/fixtures only. Do not call paid providers.

Cover:

- payload includes `maxAge`;
- research/fact-check style collection uses `maxAge: 0` by default;
- custom `maxAge` config works;
- two collections of the same URL create distinct IDs/files;
- provenance distinguishes requested/provider/cache timestamps/state;
- failed write does not leave partial JSON.

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
docs/agents/runs/RP-02-provenance.md
```

Include metadata, summary, files changed, decisions, tests and results, risks, remaining work, rollback instructions. Be truthful about model/runtime. If unknown, write `unknown`.

## Output to coordinator

When done, report:

- changed files;
- tests run and result;
- compatibility decisions;
- risks;
- whether the branch is ready for external review.
