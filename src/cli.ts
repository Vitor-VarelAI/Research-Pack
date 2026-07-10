#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { createFirecrawlProvider, runFirecrawlAgent, scrapeFirecrawlStructured } from "./providers/firecrawl.js";
import { createFileStore } from "./storage/file-store.js";
import { CrawlOptionsSchema, type RunRecord, type ScrapedDocument } from "./types.js";
import { extractBuiltIn, type BuiltInSchemaName } from "./extract.js";
import {
  getBuiltInExtractionJsonSchema,
  isBuiltInExtractionSchemaName,
  parseBuiltInExtraction,
} from "./schemas/registry.js";
import { validateSourceGateFile } from "./schemas/source-gate.js";
import { makeId, nowIso } from "./util.js";
import { getHnAiContext, getHnTopStories } from "./hn.js";
import { buildRadarReportFromHn } from "./radar.js";

const program = new Command();

program
  .name("scrape-agent")
  .description("Backend-first scrape agent MVP powered by Firecrawl")
  .version("0.1.0");

program
  .command("scrape")
  .description("Scrape one URL and save raw JSON + markdown")
  .argument("<url>", "URL to scrape")
  .option("--json", "print full JSON instead of summary")
  .option("--max-age <ms>", "Firecrawl maxAge in ms (omit to skip; 0 forces fresh)", parseInteger)
  .action(async (url: string, options: { json?: boolean; maxAge?: number }) => {
    const maxAgeMs = resolveContentMaxAge(options.maxAge);
    const provider = createFirecrawlProvider();
    const store = createFileStore();
    const document = await provider.scrape(url, maxAgeMs !== undefined ? { maxAgeMs } : undefined);
    await store.saveDocument(document);
    await saveRun("scrape", { url, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) }, { documentId: document.id, url: document.url });
    print(options.json ? document : summarizeDocument(document));
  });

program
  .command("map")
  .description("Discover URLs on a site")
  .argument("<url>", "URL to map")
  .option("--limit <number>", "max URLs to print", parseInteger, 50)
  .action(async (url: string, options: { limit: number }) => {
    const provider = createFirecrawlProvider();
    const links = (await provider.map(url)).slice(0, options.limit);
    await saveRun("map", { url, limit: options.limit }, { count: links.length, links });
    print({ count: links.length, links });
  });

program
  .command("crawl")
  .description("Crawl a site and save documents")
  .argument("<url>", "URL to crawl")
  .option("--limit <number>", "max pages", parseInteger, 10)
  .option("--include <paths...>", "include path globs")
  .option("--exclude <paths...>", "exclude path globs")
  .option("--wait-for <ms>", "wait before extraction", parseInteger)
  .option("--max-age <ms>", "Firecrawl maxAge in ms for crawl scrapeOptions (omit to skip; 0 forces fresh)", parseInteger)
  .action(async (url: string, options: { limit: number; include?: string[]; exclude?: string[]; waitFor?: number; maxAge?: number }) => {
    const provider = createFirecrawlProvider();
    const store = createFileStore();
    const crawlOptions = CrawlOptionsSchema.parse({
      limit: options.limit,
      includePaths: options.include,
      excludePaths: options.exclude,
      waitForMs: options.waitFor,
      maxAgeMs: resolveContentMaxAge(options.maxAge),
    });
    const result = await provider.crawl(url, crawlOptions);
    await Promise.all(result.documents.map((document) => store.saveDocument(document)));
    await saveRun("crawl", { url, ...crawlOptions }, {
      count: result.documents.length,
      ids: result.documents.map((doc) => doc.id),
      pages: result.pages,
      creditsUsed: result.creditsUsed,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      expiresAt: result.expiresAt,
    });
    print({
      count: result.documents.length,
      documents: result.documents.map(summarizeDocument),
      pages: result.pages,
      creditsUsed: result.creditsUsed,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      expiresAt: result.expiresAt,
    });
  });

program
  .command("extract")
  .description("Scrape one URL and extract into a built-in schema")
  .argument("<url>", "URL to extract from")
  .option("--schema <name>", "built-in schema name: article", "article")
  .option("--max-age <ms>", "Firecrawl maxAge in ms (omit to skip; 0 forces fresh)", parseInteger)
  .action(async (url: string, options: { schema: string; maxAge?: number }) => {
    if (options.schema !== "article") throw new Error(`Unknown schema: ${options.schema}`);
    const maxAgeMs = resolveContentMaxAge(options.maxAge);
    const provider = createFirecrawlProvider();
    const store = createFileStore();
    const document = await provider.scrape(url, maxAgeMs !== undefined ? { maxAgeMs } : undefined);
    const extraction = extractBuiltIn(options.schema as BuiltInSchemaName, document);
    await store.saveDocument(document);
    await store.saveExtraction(`${options.schema}-${document.id}`, extraction);
    await saveRun("extract", { url, schema: options.schema, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}) }, { documentId: document.id, extraction });
    print(extraction);
  });

program
  .command("extract-ai")
  .description("Scrape one URL and extract structured JSON using Firecrawl JSON mode")
  .argument("<url>", "URL to extract from")
  .option("--schema <name>", "built-in schema: article | web-research", "web-research")
  .option("--prompt <text>", "extraction instruction", "Extract only facts explicitly supported by the page. Include evidence and source URLs when available.")
  .option("--max-age <ms>", "Firecrawl maxAge in ms (default 0 = force fresh, research/fact-check)", parseInteger)
  .action(async (url: string, options: { schema: string; prompt: string; maxAge?: number }) => {
    if (options.schema === "fact-check") {
      throw new Error(
        "extract-ai --schema fact-check is deprecated for single-page usage.\n" +
          "Migration: use `agent` for multi-page source-gate extraction, or wait for the future `research` command.\n" +
          "The canonical source sufficiency gate contract now lives in src/schemas/source-gate.ts.\n" +
          "Validate a gate result JSON file with: scrape-agent source-gate --validate <file.json>.",
      );
    }
    if (!isBuiltInExtractionSchemaName(options.schema)) throw new Error(`Unknown schema: ${options.schema}`);
    const maxAgeMs = resolveResearchMaxAge(options.maxAge);
    const result = await scrapeFirecrawlStructured({
      url,
      prompt: options.prompt,
      schema: getBuiltInExtractionJsonSchema(options.schema),
      maxAgeMs,
    });
    const parsed = parseBuiltInExtraction(options.schema, result.data);
    const store = createFileStore();
    await store.saveDocument(result.document);
    await store.saveExtraction(`extract-ai-${options.schema}-${result.document.id}`, parsed);
    await saveRun("extract-ai", { url, schema: options.schema, prompt: options.prompt, maxAgeMs }, { documentId: result.document.id, extraction: parsed });
    print(parsed);
  });

program
  .command("radar-hn")
  .description("Collect broad HN radar signals without editorial filtering")
  .option("--top <number>", "HN top stories to inspect", parseInteger, 120)
  .option("--limit <number>", "radar items to return", parseInteger, 20)
  .action(async (options: { top: number; limit: number }) => {
    const stories = await getHnTopStories(options.top);
    const report = buildRadarReportFromHn(stories, options.limit);
    await saveRun("radar-hn", options, { itemCount: report.items.length, items: report.items });
    print(report);
  });

program
  .command("hn-ai")
  .description("Fetch top AI stories from Hacker News plus same-frontpage context")
  .option("--top <number>", "HN top stories to inspect", parseInteger, 120)
  .option("--limit <number>", "AI stories to return", parseInteger, 3)
  .option("--neighbors <number>", "same-frontpage neighbor stories to include", parseInteger, 12)
  .action(async (options: { top: number; limit: number; neighbors: number }) => {
    const context = await getHnAiContext({
      topStoriesLimit: options.top,
      aiStoriesLimit: options.limit,
      neighborLimit: options.neighbors,
    });
    await saveRun("hn-ai", options, { aiStories: context.aiStories, sameBoard: context.sameBoard });
    print(context);
  });

program
  .command("agent")
  .description("Use Firecrawl Agent for multi-page structured LLM extraction")
  .argument("<prompt>", "task for the web extraction agent")
  .option("--url <urls...>", "optional URLs to focus the agent")
  .option("--schema <name>", "built-in schema: article | web-research", "web-research")
  .option("--model <name>", "Firecrawl Spark model: spark-1-mini | spark-1-pro", "spark-1-mini")
  .option("--max-age <ms>", "Firecrawl maxAge in ms (default 0 = force fresh, research/fact-check)", parseInteger)
  .action(async (prompt: string, options: { url?: string[]; schema: string; model: string; maxAge?: number }) => {
    if (!isBuiltInExtractionSchemaName(options.schema)) throw new Error(`Unknown schema: ${options.schema}`);
    if (options.model !== "spark-1-mini" && options.model !== "spark-1-pro") throw new Error(`Unknown model: ${options.model}`);

    const maxAgeMs = resolveResearchMaxAge(options.maxAge);
    const result = await runFirecrawlAgent({
      prompt,
      ...(options.url ? { urls: options.url } : {}),
      schema: getBuiltInExtractionJsonSchema(options.schema),
      model: options.model,
      maxAgeMs,
    });
    const parsed = parseBuiltInExtraction(options.schema, result.data);
    const store = createFileStore();
    await store.saveExtraction(`agent-${options.schema}-${makeId("result")}`, parsed);
    await saveRun("agent", { prompt, urls: options.url ?? [], schema: options.schema, model: options.model, maxAgeMs }, { result: parsed });
    print(parsed);
  });

program
  .command("source-gate")
  .description("Source sufficiency gate: validate a source-gate result JSON file before linters run")
  .option("--validate <file>", "validate a source-gate result JSON file and print the parsed result")
  .action(async (options: { validate?: string }) => {
    if (!options.validate) {
      throw new Error(
        "source-gate requires --validate <file.json>. " +
          "Produce a gate result via scripts/fact-check.sh (see prompts/fact-check.md), then validate it here.",
      );
    }
    const result = validateSourceGateFile(options.validate);
    if (!result.pass) {
      throw new Error(
        `Source sufficiency gate BLOCKED: pass=false, diagnosisAllowed=false. ` +
          `Found ${result.anchors.length} anchors (sensitive: ${result.sensitiveCategories.length > 0}).`,
      );
    }
    if (!result.diagnosisAllowed) {
      throw new Error("Source sufficiency gate BLOCKED: diagnosisAllowed=false despite pass=true.");
    }
    print(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`scrape-agent: ${message}`);
  process.exitCode = 1;
});

async function saveRun(command: string, input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
  const store = createFileStore();
  const record: RunRecord = {
    id: makeId("run"),
    command,
    input,
    output,
    createdAt: nowIso(),
  };
  await store.saveRun(record);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

/**
 * Resolve maxAge for general content commands (scrape/extract/crawl).
 *
 * Returns the explicit `--max-age` value if given, else the
 * `SCRAPE_AGENT_DEFAULT_MAX_AGE_MS` env var if set, else `undefined` (maxAge
 * is not sent in the Firecrawl payload).
 */
function resolveContentMaxAge(explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit;
  const env = process.env.SCRAPE_AGENT_DEFAULT_MAX_AGE_MS;
  if (env !== undefined && env !== "") {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Resolve maxAge for research/fact-check style commands (extract-ai, agent).
 * Defaults to `0` (force fresh, never serve cache) unless overridden.
 */
function resolveResearchMaxAge(explicit: number | undefined): number {
  return explicit ?? 0;
}

function summarizeDocument(document: ScrapedDocument): Record<string, unknown> {
  return {
    id: document.id,
    url: document.url,
    title: document.title ?? null,
    provider: document.provider,
    markdownChars: document.markdown?.length ?? 0,
    links: document.links.length,
    provenance: document.provenance,
  };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
