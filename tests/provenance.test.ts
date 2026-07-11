import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createFirecrawlProvider, scrapeFirecrawlStructured, runFirecrawlAgent } from "../src/providers/firecrawl.js";
import { createFileStore } from "../src/storage/file-store.js";
import { writeJson } from "../src/util.js";
import type { ScrapedDocument } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const mockFirecrawlPath = path.join(repoRoot, "tests", "fixtures", "mock-firecrawl-fetch.ts");

type CapturedRequest = { url: string; body: unknown };

function installCaptureMock(options: { cache?: "cached" | "fresh" | "none"; cacheState?: string; metadataCacheState?: string; scrapedAt?: string } = {}): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  const cache = options.cache ?? "none";
  const cacheFields = options.cacheState !== undefined
    ? { cacheState: options.cacheState }
    : cache === "cached" ? { fromCache: true, cacheState: "hit" }
    : cache === "fresh" ? { fromCache: false, cacheState: "miss" }
    : {};
  const scrapedAt = options.scrapedAt ?? "2026-07-10T00:00:00.000Z";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });

    if (url.endsWith("/scrape")) {
      return Response.json({
        success: true,
        ...cacheFields,
        data: {
          markdown: "# Mocked",
          html: "<p>Mocked</p>",
          links: ["https://example.com/a"],
          metadata: {
            sourceURL: "https://example.com/page",
            title: "Mocked",
            scrapedAt,
            ...(options.metadataCacheState !== undefined ? { cacheState: options.metadataCacheState } : {}),
          },
          json: { answer: "x", facts: [], sources: [], confidence: "medium" },
        },
      });
    }
    if (url.endsWith("/agent")) {
      return Response.json({ success: true, data: { answer: "x", facts: [], sources: [], confidence: "medium" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;

  return { requests, restore: () => { globalThis.fetch = original; } };
}

describe("Firecrawl maxAge payload", () => {
  let restore: () => void;
  let requests: CapturedRequest[];

  beforeEach(() => {
    const mock = installCaptureMock();
    requests = mock.requests;
    restore = mock.restore;
  });

  afterEach(() => restore());

  it("scrape payload includes maxAge when provided", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key" });
    await provider.scrape("https://example.com/page", { maxAgeMs: 5000 });
    const body = requests[0]?.body as Record<string, unknown>;
    assert.equal(body.maxAge, 5000);
  });

  it("scrape payload omits maxAge when not provided", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key" });
    await provider.scrape("https://example.com/page");
    const body = requests[0]?.body as Record<string, unknown>;
    assert.equal("maxAge" in body, false);
  });

  it("custom maxAge config is forwarded exactly", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key" });
    await provider.scrape("https://example.com/page", { maxAgeMs: 1234 });
    assert.equal((requests[0]?.body as Record<string, unknown>).maxAge, 1234);
  });

  it("structured scrape (extract-ai) sends maxAge:0 by default", async () => {
    await scrapeFirecrawlStructured({ url: "https://example.com/page", prompt: "p", schema: {}, maxAgeMs: 0 }, { apiKey: "test-key" });
    const body = requests[0]?.body as Record<string, unknown>;
    assert.equal(body.maxAge, 0);
  });

  it("agent omits maxAge from Firecrawl payload but returns requested freshness provenance", async () => {
    const result = await runFirecrawlAgent({ prompt: "p", schema: {}, model: "spark-1-mini", maxAgeMs: 0 }, { apiKey: "test-key" });
    const body = requests[0]?.body as Record<string, unknown>;
    assert.equal("maxAge" in body, false);
    assert.equal(result.provenance.maxAgeMs, 0);
    assert.ok(typeof result.provenance.requestedAt === "string" && result.provenance.requestedAt.length > 0);
  });
});

describe("provenance distinguishes requested/provider/cache", () => {
  it("requestedAt differs from providerTimestamp and is recorded on the document", async () => {
    const providerScrapedAt = "2026-01-01T00:00:00.000Z";
    const { requests: _r, restore } = installCaptureMock({ scrapedAt: providerScrapedAt });
    try {
      void _r;
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page", { maxAgeMs: 0 });
      assert.equal(doc.fetchedAt, doc.provenance.requestedAt);
      assert.equal(doc.provenance.providerTimestamp, providerScrapedAt);
      assert.notEqual(doc.provenance.requestedAt, doc.provenance.providerTimestamp);
      assert.equal(doc.provenance.maxAgeMs, 0);
    } finally {
      restore();
    }
  });

  it("cached content is marked cached, not silently 'now/fresh'", async () => {
    const { restore } = installCaptureMock({ cache: "cached" });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page", { maxAgeMs: 5000 });
      assert.equal(doc.provenance.cacheState, "cached");
      assert.ok(doc.provenance.cacheStatus !== null);
      // Cached content still records when we requested it + the maxAge used.
      assert.equal(doc.provenance.maxAgeMs, 5000);
      assert.ok(doc.provenance.requestedAt.length > 0);
    } finally {
      restore();
    }
  });

  it("fresh content is marked fresh", async () => {
    const { restore } = installCaptureMock({ cache: "fresh" });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page", { maxAgeMs: 0 });
      assert.equal(doc.provenance.cacheState, "fresh");
    } finally {
      restore();
    }
  });

  it("unknown cache state when provider reports nothing", async () => {
    const { restore } = installCaptureMock({ cache: "none" });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page");
      assert.equal(doc.provenance.cacheState, "unknown");
      assert.equal(doc.provenance.cacheStatus, null);
      assert.equal(doc.provenance.maxAgeMs, null);
    } finally {
      restore();
    }
  });

  it("unrecognized top-level cacheState remains unknown", async () => {
    const { restore } = installCaptureMock({ cacheState: "revalidated" });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page");
      assert.equal(doc.provenance.cacheState, "unknown");
      assert.equal(doc.provenance.cacheStatus, "revalidated");
    } finally {
      restore();
    }
  });

  it("unrecognized metadata cacheState remains unknown", async () => {
    const { restore } = installCaptureMock({ metadataCacheState: "edge-cache" });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const doc = await provider.scrape("https://example.com/page");
      assert.equal(doc.provenance.cacheState, "unknown");
      assert.equal(doc.provenance.cacheStatus, "edge-cache");
    } finally {
      restore();
    }
  });
});

describe("immutable snapshots per collection", () => {
  it("two collections of the same URL create distinct document ids", async () => {
    const { restore } = installCaptureMock();
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key" });
      const a = await provider.scrape("https://example.com/page");
      const b = await provider.scrape("https://example.com/page");
      assert.notEqual(a.id, b.id);
      assert.equal(a.url, b.url);
    } finally {
      restore();
    }
  });

  it("two collections of the same URL write distinct raw + markdown files (no overwrite)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "snap-"));
    try {
      const store = createFileStore(dataDir);
      const docA: ScrapedDocument = {
        id: "doc_aaa",
        url: "https://example.com/page",
        markdown: "# A",
        links: [],
        metadata: {},
        fetchedAt: "2026-07-10T00:00:00.000Z",
        provider: "firecrawl",
        provenance: { requestedAt: "2026-07-10T00:00:00.000Z", maxAgeMs: 0, providerTimestamp: null, cacheState: "fresh", cacheStatus: null },
      };
      const docB: ScrapedDocument = {
        ...docA,
        id: "doc_bbb",
        markdown: "# B",
        fetchedAt: "2026-07-10T00:00:01.000Z",
        provenance: { ...docA.provenance, requestedAt: "2026-07-10T00:00:01.000Z" },
      };
      await store.saveDocument(docA);
      await store.saveDocument(docB);

      const rawFiles = readdirSync(path.join(dataDir, "raw"));
      const mdFiles = readdirSync(path.join(dataDir, "markdown"));
      assert.equal(rawFiles.length, 2);
      assert.equal(mdFiles.length, 2);

      // First snapshot content must be preserved (not overwritten by the second).
      const firstRaw = readFileSync(path.join(dataDir, "raw", rawFiles.find((f) => f.includes("doc_aaa"))!), "utf8");
      const firstMd = readFileSync(path.join(dataDir, "markdown", mdFiles.find((f) => f.includes("doc_aaa"))!), "utf8");
      assert.match(firstRaw, /doc_aaa/);
      assert.equal(firstMd, "# A");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("atomic JSON writes", () => {
  it("a simulated write failure does not leave partial JSON at the target path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-"));
    try {
      const target = path.join(dir, "doc.json");
      await writeJson(target, { original: true });
      const before = readFileSync(target, "utf8");
      assert.match(before, /"original": true/);

      // Make the directory read-only so the temp-file write fails. The
      // pre-existing target must remain intact and no .tmp partial may remain.
      chmodSync(dir, 0o500);
      await assert.rejects(() => writeJson(target, { newContent: true }));

      const after = readFileSync(target, "utf8");
      assert.equal(after, before, "original target must be unchanged after failed write");

      const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
      assert.equal(leftovers.length, 0, "no partial temp file may remain");
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("successful write replaces content fully and leaves no temp file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-ok-"));
    try {
      const target = path.join(dir, "doc.json");
      await writeJson(target, { v: 1 });
      await writeJson(target, { v: 2 });
      const after = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(after.v, 2);
      const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
      assert.equal(leftovers.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI research/fact-check maxAge default", () => {
  it("extract-ai defaults to maxAge:0 in the Firecrawl payload", () => {
    const recordFile = path.join(mkdtempSync(path.join(tmpdir(), "cli-rec-")), "record.json");
    const dataDir = mkdtempSync(path.join(tmpdir(), "cli-data-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", mockFirecrawlPath, cliPath, "extract-ai", "https://example.com/page"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            FIRECRAWL_API_KEY: "test-key",
            SCRAPE_AGENT_DATA_DIR: dataDir,
            MOCK_FIRECRAWL_RECORD: recordFile,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(recordFile), "mock must have recorded the request");
      const recorded = JSON.parse(readFileSync(recordFile, "utf8")) as Array<{ url: string; body: Record<string, unknown> }>;
      const scrapeReq = recorded.find((r) => r.url.endsWith("/scrape"));
      assert.ok(scrapeReq, "a scrape request must have been made");
      assert.equal(scrapeReq.body.maxAge, 0);
    } finally {
      rmSync(path.dirname(recordFile), { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("agent omits maxAge from Firecrawl payload", () => {
    const recordFile = path.join(mkdtempSync(path.join(tmpdir(), "cli-rec-")), "record.json");
    const dataDir = mkdtempSync(path.join(tmpdir(), "cli-data-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", mockFirecrawlPath, cliPath, "agent", "research it", "--schema", "web-research"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            FIRECRAWL_API_KEY: "test-key",
            SCRAPE_AGENT_DATA_DIR: dataDir,
            MOCK_FIRECRAWL_RECORD: recordFile,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const recorded = JSON.parse(readFileSync(recordFile, "utf8")) as Array<{ url: string; body: Record<string, unknown> }>;
      const agentReq = recorded.find((r) => r.url.endsWith("/agent"));
      assert.ok(agentReq, "an agent request must have been made");
      assert.equal("maxAge" in agentReq.body, false);
    } finally {
      rmSync(path.dirname(recordFile), { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("scrape forwards --max-age into the Firecrawl payload", () => {
    const recordFile = path.join(mkdtempSync(path.join(tmpdir(), "cli-rec-")), "record.json");
    const dataDir = mkdtempSync(path.join(tmpdir(), "cli-data-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", mockFirecrawlPath, cliPath, "scrape", "https://example.com/page", "--max-age", "7000"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            FIRECRAWL_API_KEY: "test-key",
            SCRAPE_AGENT_DATA_DIR: dataDir,
            MOCK_FIRECRAWL_RECORD: recordFile,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const recorded = JSON.parse(readFileSync(recordFile, "utf8")) as Array<{ url: string; body: Record<string, unknown> }>;
      const scrapeReq = recorded.find((r) => r.url.endsWith("/scrape"));
      assert.ok(scrapeReq);
      assert.equal(scrapeReq.body.maxAge, 7000);
    } finally {
      rmSync(path.dirname(recordFile), { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
