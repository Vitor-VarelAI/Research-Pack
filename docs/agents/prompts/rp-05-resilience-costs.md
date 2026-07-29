# RP-05 worker prompt - HTTP resilience and cost controls

You are the implementation worker for Issue #15 in `Vitor-VarelAI/Research-Pack`.

Repository worktree:

```text
/home/vitor/projects/Research-Pack-rp-05
```

Branch:

```text
agent/rp-05-resilience-costs
```

Base SHA:

```text
3ffafb0d060ed6c5c04be3bbd4b2ee6200cf5277
```

## Model policy

Use only `zai/glm-5.2` or `deepseek/deepseek-v4-pro` for worker/reviewer routing. Do not use OpenGo/OpenCode models, Qwen, Claude/Fable/Opus/Sonnet, `gpt-5.5`, or DeepSeek Flash for this project.

## Must read before editing

- `AGENTS.md`
- `docs/agents/PROTOCOL.md`
- `docs/agents/STATUS.md`
- `docs/adr/0002-provenance-cache-semantics.md`
- `docs/adr/0003-crawl-pagination-semantics.md`
- `docs/agents/runs/RP-04-radar-cli.md`
- Issue #15
- Linked follow-ups #14 and #10

Do not reveal, copy, or summarize private/personal content. Do not modify `.env`, `data/`, `profiles/editorial/soul.md`, or `profiles/editorial/voice.md`.

## Goal

Harden Firecrawl HTTP behavior and cost controls while preserving RP-02 provenance and RP-03 same-origin pagination safety.

## Required behavior

- Fix #14: the `agent` command must not send a `/agent` payload shape Firecrawl rejects because of top-level `maxAge`.
- Preserve the requested freshness policy in run input and result provenance.
- Close #10: unrecognized Firecrawl cache strings map to `cacheState: "unknown"`, not `fresh`, with regression coverage for both response and metadata cache-state branches.
- Add bounded retries for transient Firecrawl HTTP statuses: `408`, `429`, `500`, `502`, `503`, `504`.
- Add request timeout behavior for authenticated Firecrawl calls.
- Keep retry caps explicit and low.
- Do not weaken the crawl `next` same-origin guard.
- Document timeout/retry/freshness/cost semantics in an ADR.

## Required validation

```bash
npm test
npm run typecheck
npm run build
bash -n scripts/*.sh
git diff --check
```

Tests must use local mocks only. No paid provider calls.

## Handoff

Create/update:

```text
docs/agents/runs/RP-05-resilience-costs.md
```

Include metadata, summary, files changed, decisions, tests/results, risks, remaining work, and rollback instructions.
