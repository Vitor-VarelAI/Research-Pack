# RP-04 worker prompt — Radar and CLI validation

You are the implementation worker for Issue #12 in `Vitor-VarelAI/Research-Pack`.

Repository worktree:

```text
/home/vitor/projects/Research-Pack-rp-04
```

Branch:

```text
agent/rp-04-radar-cli
```

Base SHA:

```text
34c0e75b64dfbc05360904d9eb892b220d3955fd
```

## Model policy

You must be running on `zai/glm-5.2` or `deepseek/deepseek-v4-pro`. Do not use OpenGo/OpenCode models. Do not use DeepSeek V4 Flash.

## Must read before editing

- `AGENTS.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/adr/0002-provenance-cache-semantics.md`
- `docs/adr/0003-crawl-pagination-semantics.md`
- handoffs through `docs/agents/runs/RP-03-crawl-pagination.md`
- Issue #12 text if available

Do not reveal or copy private/personal content. Do not modify `.env`, `data/`, `profiles/editorial/soul.md`, or `profiles/editorial/voice.md`.

## Goal

Fix radar false positives and harden CLI integer validation before any request is made.

## Required behaviour

- Correct radar regexes using word boundaries or tokenization.
- Avoid false positives:
  - `Build -> UI`
  - `Postgres/Rust -> OS/US`
  - `programming -> PR`
  - `happy/mapping -> app`
- Preserve true detections of UI, API, EU, US and PR.
- Validate every CLI integer option as a full integer string.
- Reject negative, zero, partial strings like `10foo`, and excessive values before any HN/provider request.
- Limit HN request concurrency and test the maximum observed concurrency.
- Preserve valid command compatibility.

## Required tests

Use local mocks/fixtures only. Do not call paid providers.

Cover:

- false positive cases;
- true positive cases for UI/API/EU/US/PR;
- radar sorting/scoring remains deterministic;
- invalid integer options reject before requests;
- valid integer options still work;
- HN concurrency never exceeds the configured limit.

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
docs/agents/runs/RP-04-radar-cli.md
```

Include metadata, summary, files changed, decisions, tests and results, risks, remaining work, rollback instructions.

## Output to coordinator

When done, report changed files, tests, compatibility decisions, risks, and readiness for review.
