# ADR 0004: Cockpit control-plane contracts and direct generation provider

- Status: accepted
- Date: 2026-03-01
- Updated: 2026-07-26

## Decision

Phase 1 uses strict Zod-first contracts for editorial inputs, persisted jobs, stage outputs, events and publication packages. Job state is a finite state machine with one active job in `data/control/jobs`; `job.json` is replaced atomically and `events.jsonl` is bounded and append-only. A restart marks queued or executing jobs `interrupted`, while the two human-gate states remain waiting.

Editorial generation has one concrete backend: an OpenAI-compatible DeepSeek HTTP client. The server resolves `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` explicitly; none has a default and no request can choose a provider, model, prompt, executable or path. Provider errors are mapped to safe codes and response bodies are never persisted or included in errors.

Research collection routes by input contract. A URL input is fresh-scraped directly, then issues one Firecrawl Search request limited to five URL-only results while excluding the seed domain. The application rejects navigation/policy pages, duplicate hosts, private targets and invalid URLs before fresh-scraping the remaining candidate anchors; Search never receives `scrapeOptions`, and this path never starts Firecrawl Agent discovery. A topic input has no seed URL, so it uses one fixed, bounded Firecrawl Agent discovery task and fresh-scrapes only the validated URLs returned by that task. Agent status is polled every two seconds with a five-minute client deadline. That deadline bounds the local runner rather than the remote provider lifetime: Firecrawl may continue processing after the cockpit stops polling. Exhausting the deadline raises `provider_timeout`, preserves the generic public failure message, and writes a bounded, sanitised diagnostic event with the remote job ID. Firecrawl exposes no documented free-only Agent request parameter, so topic retries may repeat provider work and may consume paid credits after the provider's free daily quota.

The source gate is evaluated by application code from canonical, successfully scraped anchors before diagnosis; model output may classify those anchors and extract claims but cannot add URLs or forge gate counts. Angle selection and final approval are explicit runner actions. Rejection uses the existing `failed` terminal state with `human_rejected`; retry reuses valid upstream artifacts where possible, but the user is warned that repeating a failed paid stage may incur provider generation again.

Packages are built in a contained staging directory, validated against the existing publication schema, optionally exported to HTML, and promoted atomically to `data/editorial/<slug>`. No delivery or publication side effect is part of this boundary.

## Consequences

The runner is usable by the later API and by a non-interactive CLI without exposing a generic command surface. The browser/API can remain a product surface over this boundary, and tests can inject local collectors and generation functions without contacting paid providers. Production QA uses the direct DeepSeek client for exactly one editorial check and one formats check; code combines their strict verdicts conservatively before the final human gate. DeepSeek requires explicit `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` configuration.

User and discovered hostnames undergo a public-address DNS preflight before scraping. Remote-provider DNS resolution remains residual: the application cannot pin the provider's later DNS resolution, so this check is a preflight rather than a claim of complete SSRF prevention. Events are advisory telemetry, not the source of truth; a crash between the atomic job file replacement and event append can leave them briefly inconsistent, which V1 accepts instead of adding a database. Diagnostic events are sanitised and bounded before persistence, while provider response bodies, credentials and local paths remain excluded.
