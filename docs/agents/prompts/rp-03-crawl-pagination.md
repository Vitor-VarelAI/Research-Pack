# RP-03 worker prompt — Crawl pagination

You are the implementation worker for Issue #9 in `Vitor-VarelAI/Research-Pack`.

Repository worktree:

```text
/home/vitor/projects/Research-Pack-rp-03
```

Branch:

```text
agent/rp-03-crawl-pagination
```

Base SHA:

```text
d9e39ba31b5bf99bf6cc6e287f50ba40bb07f98a
```

## Model policy

You must be running on `zai/glm-5.2` or `deepseek/deepseek-v4-pro`. Do not use OpenGo/OpenCode models. Do not use DeepSeek V4 Flash.

## Must read before editing

- `AGENTS.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/adr/0002-provenance-cache-semantics.md`
- `docs/agents/runs/RP-GOV-governance.md`
- `docs/agents/runs/RP-00-baseline.md`
- `docs/agents/runs/RP-01-source-gate.md`
- `docs/agents/runs/RP-02-provenance.md`
- Issue #9 text if available

Do not reveal or copy private/personal content. Do not modify `.env`, `data/`, `profiles/editorial/soul.md`, or `profiles/editorial/voice.md`.

## Goal

Implement safe Firecrawl crawl pagination and preserve pagination/cost metadata.

## Required behaviour

- Crawl status/response schemas support `next`, `creditsUsed`, duration and timestamps where provider responses expose them.
- Follow all valid `next` pages and aggregate all documents.
- Support relative `next` URLs.
- Support absolute same-origin `next` URLs.
- Reject cross-origin `next` URLs before sending bearer token to another origin.
- Preserve credits/duration/timestamps in run outputs or relevant result/provenance structures.
- Keep existing `crawl` command compatibility.

## Required tests

Use local mocks/fixtures only. Do not call paid providers.

Cover:

- one page without `next`;
- multiple pages;
- absolute same-origin `next`;
- relative `next`;
- cross-origin `next` rejected and token not sent cross-origin;
- malformed paginated response;
- credits/duration/timestamps preserved.

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
docs/agents/runs/RP-03-crawl-pagination.md
```

Include metadata, summary, files changed, decisions, tests and results, risks, remaining work, rollback instructions. Be truthful about model/runtime. If unknown, write `unknown`.

## Output to coordinator

When done, report:

- changed files;
- tests run and result;
- compatibility decisions;
- risks;
- whether the branch is ready for external review.
