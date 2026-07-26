# scrape-agent

Backend-first scrape agent MVP powered by Firecrawl.

## Setup

```bash
cd ~/projects/scrape-agent
cp .env.example .env
# edit .env and set FIRECRAWL_API_KEY plus the explicit DeepSeek variables
# DEEPSEEK_API_KEY=...
# DEEPSEEK_BASE_URL=https://...
# DEEPSEEK_MODEL=...
npm install
npm run build
```

## Commands

```bash
npm run dev -- scrape https://example.com
npm run dev -- map https://example.com --limit 20
npm run dev -- crawl https://example.com --limit 10
npm run dev -- extract https://example.com --schema article
npm run dev -- extract-ai https://example.com --schema web-research --prompt "Summarize with cited facts only"
npm run dev -- extract-ai https://example.com --schema fact-check --prompt "Extract source anchors and confirmed claims only"
npm run dev -- agent "Find the pricing plans for Notion" --url https://www.notion.so/pricing --schema web-research
npm run dev -- hn-ai --limit 3 --neighbors 10
npm run dev -- radar-hn --limit 20 --top 120
npm run export:html -- /absolute/path/to/editorial-package
```

## Visual cockpit

The cockpit is a private editorial operations desk over existing artifacts and the fixed control-plane API. Actions remain disabled by default; set `SCRAPE_AGENT_COCKPIT_ACTIONS=1` and the exact server-only `SCRAPE_AGENT_COCKPIT_ORIGIN` only after local validation. The runner accepts a validated URL or topic, uses bounded Firecrawl discovery and direct DeepSeek generation, and never accepts shell, provider, model, prompt, executable or path options from the browser. The UI advertises actions only when `FIRECRAWL_API_KEY`, `DEEPSEEK_API_KEY`, a valid HTTP(S) `DEEPSEEK_BASE_URL`, and `DEEPSEEK_MODEL` are present in the service environment. This readiness check is local: it creates no provider clients and makes no network requests. Read-only browsing remains available when provider configuration is absent or invalid. The default data root is `data/`; point it at an existing runtime data directory with `SCRAPE_AGENT_DATA_DIR`.

```bash
SCRAPE_AGENT_DATA_DIR=/home/vitor/projects/scrape-agent/data npm run cockpit
# opens http://127.0.0.1:4173
```

For the persistent VPS deployment, install `ops/scrape-agent-cockpit.service` as the `vitor` user at `~/.config/systemd/user/scrape-agent-cockpit.service`. Keep non-secret cockpit settings in `~/.config/scrape-agent-cockpit/env` and provider credentials in the dedicated `~/.config/scrape-agent-cockpit/providers.env`; both files must be mode `0600`. The unit loads `providers.env` optionally, so a missing file leaves the cockpit available in read-only/configuration-required mode. Cockpit code never auto-loads a repository `.env`, and the unit keeps `/home/vitor/projects/scrape-agent/.env` inaccessible to the process.

Create the files, install the unit, and activate it:

```bash
install -d -m 700 ~/.config/scrape-agent-cockpit ~/.config/systemd/user
printf '%s\n' \
  'SCRAPE_AGENT_DATA_DIR=/home/vitor/projects/scrape-agent/data' \
  'SCRAPE_AGENT_HOST=127.0.0.1' \
  'SCRAPE_AGENT_PORT=4173' > ~/.config/scrape-agent-cockpit/env
chmod 600 ~/.config/scrape-agent-cockpit/env
install -m 0600 /dev/null ~/.config/scrape-agent-cockpit/providers.env
# Edit providers.env locally and add valid values for exactly:
# FIRECRAWL_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
${EDITOR:-vi} ~/.config/scrape-agent-cockpit/providers.env
install -m 0644 ops/scrape-agent-cockpit.service ~/.config/systemd/user/scrape-agent-cockpit.service
npm run build
systemctl --user daemon-reload
systemctl --user enable --now scrape-agent-cockpit.service
tailscale serve --bg --yes --https=10000 http://127.0.0.1:4173
```

Keep the cockpit on `127.0.0.1:4173`; Tailscale Serve is the only remote boundary and must remain tailnet-only. The existing Studio mapping on HTTPS `:443` must stay unchanged, port `8443` is reserved, and Funnel must not be enabled. The cockpit URL is `https://vmi3305438.tail917695.ts.net:10000/`. To roll back only this deployment, run `tailscale serve --https=10000 off`, then `systemctl --user disable --now scrape-agent-cockpit.service` and remove the installed unit/env after preserving any needed backups; never use `tailscale serve reset`.

It accepts only `GET` and `HEAD`, keeps package and artifact paths contained under the configured root, rejects symlink escapes, and degrades individual missing or malformed artifacts into visible warnings. The radar shown in the cockpit is the latest valid global `radar-hn` run because the append-only run record has no package foreign key. It binds to `127.0.0.1` by default; a non-loopback `SCRAPE_AGENT_HOST` requires the explicitly named `SCRAPE_AGENT_ALLOW_UNSAFE_HOST=1` opt-in and emits a startup warning. Artifact reads use `O_NOFOLLOW` and the opened descriptor's `fstat`, but Node has no portable `openat` API, so a concurrent replacement of an intermediate directory remains a residual TOCTOU limitation.

Run the focused cockpit tests with `npm run test:cockpit`; the full suite remains `npm test`.

## Editorial HTML export

Export a package directory containing `publication.json` and the Markdown files listed by its `formats` entries:

```bash
npm run export:html -- /absolute/path/to/editorial-package
# writes /absolute/path/to/editorial-package/index.html atomically
```

The manifest uses `schemaVersion: 1`, locale `pt-PT`, a slug matching the package directory basename, `publishedOn`, `title`, `description`, exactly 10 slides, and exactly these seven formats: `blog`, `newsletter`, `linkedin`, `xThread`, `shortVideoIdeas`, `carousel`, and `titlesHooks`. Slides have `id`, `eyebrow`, `title`, `bodyMarkdown`, a theme from `ink | paper | sand | blue | red`, and an optional `{ value, label }` stat; the first and last themes are `ink`, there are at least five dark slides, no adjacent themes repeat, and at least two slides have stats. Each format has a `label` and a relative `.md`/`.markdown` `path`; missing files, duplicate paths, traversal, absolute paths, and symlinks are rejected.

The generated file is self-contained: presentation CSS, JavaScript, slide data, and copy payloads are inline, with no runtime CDN or external font/asset requests. Opening the file gives the 10-slide presentation and a same-page `Formatos` mode with plain and rich-text copy controls.

For VPS delivery, copy and byte-verify the complete package under `/home/vitor/share-inbox/exports/vvarelai-editorial-pack/<slug>/`, then get its current public URL with:

```bash
/home/vitor/file-share/editorial-url.sh <slug>
```

The public server exposes the editorial export tree read-only; always browser-test the returned HTTPS link before reporting delivery.

## Content QA

Use the fact-check gate before diagnosis, then DeepSeek as default structural lint and Z.ai/GLM as adversarial second opinion:

```bash
scripts/fact-check.sh research-or-draft.md deepseek
scripts/editorial-lint.sh draft.md deepseek
scripts/editorial-lint.sh draft.md zai
scripts/content-qa.sh draft.md
```

Optional PT-PT lint via Hugging Face/EuroLLM is prepared, but depends on provider availability:

```bash
export HF_TOKEN=hf_...
export HF_MODEL='utter-project/EuroLLM-22B-Instruct-2512:publicai'
scripts/ptpt-lint.sh draft.md
```

Current production fallback: DeepSeek + Z.ai workers for compliance, main agent final pass for PT-PT voice.

## Editorial delivery

`data/` is local working storage. Before declaring an editorial or blog task complete, copy the full package to the shared VPS export folder and verify the copies:

```txt
/home/vitor/share-inbox/exports/vvarelai-editorial-pack/<date-topic-slug>/
```

The package includes research, source gate, diagnosis, draft, QA notes, fact-check output, and editorial-lint outputs.

After build:

```bash
npm start -- scrape https://example.com
```

Or install globally from this folder:

```bash
npm link
scrape-agent scrape https://example.com
```

## Data layout

```txt
data/
  raw/          full scraped document JSON
  markdown/     extracted markdown
  extracted/    structured extraction JSON
  runs/         append-only runs.jsonl log
  lint-runs/    content QA outputs
```

## Current architecture

```txt
src/cli.ts                  CLI entrypoint
src/providers/firecrawl.ts  Firecrawl CrawlProvider implementation
src/types.ts                Zod-first shared types
src/extract.ts              heuristic built-in extraction
src/schemas/                extraction schemas + registry, including fact-check
src/storage/file-store.ts   local file storage
src/hn.ts                   Hacker News AI/frontpage context
src/radar.ts                broad signal scoring for collection
scripts/fact-check.sh       Minimum 3-link source gate before diagnosis
scripts/editorial-lint.sh   Pi worker lint via DeepSeek/Z.ai
scripts/content-qa.sh       Runs DeepSeek + Z.ai lint together
scripts/ptpt-lint.sh        Optional HF/EuroLLM PT-PT lint
profiles/radar/criteria.md  Radar collection criteria
profiles/editorial/research-pack.md  Multi-source research pack format
profiles/editorial/fact-check.md  Minimum source anchors before diagnosis
profiles/editorial/diagnose.md  Strategic diagnosis format
```

## Next steps

- Add `diagnose <research-pack.md>` command that outputs `profiles/editorial/diagnose.md` format.
- Add a first-class `angle`/`diagnose-news` CLI command.
- Expand `profiles/radar/` into source-specific radar profiles.
- Add profile folders for `ads`, `design-md`, `motion`, etc.
- Add a `crawl4ai` provider as local fallback.
- Add SQLite/Postgres storage when results need querying.
- Add pi-worker wrappers for planner/extractor/verifier roles.
- Integrate content QA as a first-class CLI command after the workflow stabilizes.
