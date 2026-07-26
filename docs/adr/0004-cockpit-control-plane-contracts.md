# ADR 0004: Cockpit control-plane contracts and direct generation provider

- Status: accepted
- Date: 2026-03-01

## Decision

Phase 1 uses strict Zod-first contracts for editorial inputs, persisted jobs, stage outputs, events and publication packages. Job state is a finite state machine with one active job in `data/control/jobs`; `job.json` is replaced atomically and `events.jsonl` is bounded and append-only. A restart marks queued or executing jobs `interrupted`, while the two human-gate states remain waiting.

Editorial generation has one concrete backend: an OpenAI-compatible DeepSeek HTTP client. The server resolves `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` explicitly; none has a default and no request can choose a provider, model, prompt, executable or path. Provider errors are mapped to safe codes and response bodies are never persisted or included in errors.

Research collection uses a fixed, bounded Firecrawl Agent discovery task for both URL and topic inputs, then fresh-scrapes only the validated URLs returned by that task. The source gate is evaluated by application code from canonical, successfully scraped anchors before diagnosis; model output may classify those anchors and extract claims but cannot add URLs or forge gate counts. Angle selection and final approval are explicit runner actions. Rejection uses the existing `failed` terminal state with `human_rejected`; retry reuses valid upstream artifacts where possible, but the user is warned that repeating a failed paid stage may incur provider generation again.

Packages are built in a contained staging directory, validated against the existing publication schema, optionally exported to HTML, and promoted atomically to `data/editorial/<slug>`. No delivery or publication side effect is part of this boundary.

## Consequences

The runner is usable by the later API and by a non-interactive CLI without exposing a generic command surface. The browser/API can remain a product surface over this boundary, and tests can inject local collectors and generation functions without contacting paid providers. Production QA uses the direct DeepSeek client for exactly one editorial check and one formats check; code combines their strict verdicts conservatively before the final human gate. DeepSeek requires explicit `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` configuration.

User and discovered hostnames undergo a public-address DNS preflight before scraping. Remote-provider DNS resolution remains residual: the application cannot pin the provider's later DNS resolution, so this check is a preflight rather than a claim of complete SSRF prevention. Events are advisory telemetry, not the source of truth; a crash between the atomic job file replacement and event append can leave them briefly inconsistent, which V1 accepts instead of adding a database.
