# scrape-agent

Backend-first scrape agent MVP powered by Firecrawl.

## Setup

```bash
cd ~/projects/scrape-agent
cp .env.example .env
# edit .env and set FIRECRAWL_API_KEY
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
```

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
profiles/editorial/blog-post.md  Final blog/newsletter formats
profiles/editorial/blog-publish-check.md  Pre-publish editorial and SEO gate
skills/research-pack-blog/SKILL.md  Project-local blog conversion/publish skill
```

## Next steps

- Add `research "topic"` command that outputs `profiles/editorial/research-pack.md` format.
- Add `diagnose <research-pack.md>` command that outputs `profiles/editorial/diagnose.md` format.
- Add `blog <diagnose.md>` command that outputs `profiles/editorial/blog-post.md` format.
- Add `publish-check <post.md>` command that outputs `profiles/editorial/blog-publish-check.md` format.
- Add a first-class `angle`/`diagnose-news` CLI command.
- Expand `profiles/radar/` into source-specific radar profiles.
- Add profile folders for `ads`, `design-md`, `motion`, etc.
- Add a `crawl4ai` provider as local fallback.
- Add SQLite/Postgres storage when results need querying.
- Add pi-worker wrappers for planner/extractor/verifier roles.
- Integrate content QA as a first-class CLI command after the workflow stabilizes.
