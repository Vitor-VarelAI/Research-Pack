import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createFirecrawlProvider } from "../src/providers/firecrawl.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const mockFirecrawlPath = path.join(repoRoot, "tests", "fixtures", "mock-firecrawl-fetch.ts");

/**
 * RP-03: Firecrawl crawl pagination.
 *
 * All tests use an in-process fetch mock. No network, no paid providers.
 * The mock implements:
 *   POST /crawl                         -> { success, id }
 *   GET  /crawl/<id>                    -> terminal status (completed) + optional `next`
 *   GET  <next url>                     -> next status page + optional `next`
 *
 * Each request's full URL and headers are recorded so tests can assert that
 * the bearer token is never sent to a cross-origin `next` URL.
 */

type MockPage = {
  data?: Array<{ markdown?: string; metadata?: Record<string, unknown> }>;
  next?: string;
  creditsUsed?: number;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  expiresAt?: string;
  success?: boolean;
  error?: string;
  // If set, respond with HTTP non-2xx (malformed) instead of a parsed body.
  httpStatus?: number;
  // If set, return this raw (non-JSON / malformed) body string.
  rawBody?: string;
};

type CapturedRequest = { url: string; headers: Record<string, string> };

function installMock(options: {
  startId?: string;
  firstPage: MockPage;
  pages?: Record<string, MockPage>; // keyed by full next URL
}) {
  const startId = options.startId ?? "job_123";
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    }
    requests.push({ url, headers });

    // Start a crawl job.
    if (url.endsWith("/crawl") && (init?.method ?? "POST").toUpperCase() === "POST") {
      return Response.json({ success: true, id: startId });
    }

    // Initial status poll.
    if (url.endsWith(`/crawl/${startId}`)) {
      return mockResponse(options.firstPage);
    }

    // A followed `next` URL (matched by full URL).
    const followed = options.pages?.[url];
    if (followed) return mockResponse(followed);

    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;

  return {
    requests,
    restore: () => { globalThis.fetch = original; },
  };
}

function mockResponse(page: MockPage): Response {
  if (page.httpStatus !== undefined) {
    return new Response(page.rawBody ?? JSON.stringify({ error: page.error ?? "malformed" }), {
      status: page.httpStatus,
      headers: { "Content-Type": "application/json" },
    });
  }
  return Response.json({
    success: page.success ?? true,
    status: "completed",
    completed: page.data?.length ?? 0,
    total: page.data?.length ?? 0,
    ...(page.creditsUsed !== undefined ? { creditsUsed: page.creditsUsed } : {}),
    ...(page.durationMs !== undefined ? { durationMs: page.durationMs } : {}),
    ...(page.startedAt !== undefined ? { startedAt: page.startedAt } : {}),
    ...(page.finishedAt !== undefined ? { finishedAt: page.finishedAt } : {}),
    ...(page.expiresAt !== undefined ? { expiresAt: page.expiresAt } : {}),
    ...(page.next !== undefined ? { next: page.next } : {}),
    ...(page.error !== undefined ? { error: page.error } : {}),
    data: page.data ?? [],
  });
}

function pageData(markdown: string, sourceURL: string) {
  return { markdown, metadata: { sourceURL, title: markdown } };
}

const BASE = "https://api.firecrawl.dev/v2";

describe("crawl pagination — one page without next", () => {
  let restore: () => void;
  beforeEach(() => {
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")] },
    });
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("returns all documents from a single completed status with no next", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10 });
    assert.equal(result.documents.length, 1);
    assert.equal(result.pages, 1);
    assert.equal(result.documents[0]?.url, "https://example.com/a");
  });
});

describe("crawl pagination — multiple pages", () => {
  let restore: () => void;
  let requests: CapturedRequest[];
  beforeEach(() => {
    const nextUrl = `${BASE}/crawl/job_123?next=page2`;
    const mock = installMock({
      firstPage: {
        data: [pageData("# A", "https://example.com/a")],
        next: nextUrl,
      },
      pages: {
        [nextUrl]: { data: [pageData("# B", "https://example.com/b"), pageData("# C", "https://example.com/c")] },
      },
    });
    requests = mock.requests;
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("follows next and aggregates all documents across pages", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10 });
    assert.equal(result.documents.length, 3);
    assert.equal(result.pages, 2);
    const urls = result.documents.map((d) => d.url).sort();
    assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
    // The next URL was fetched exactly once.
    const nextHits = requests.filter((r) => r.url.includes("next=page2"));
    assert.equal(nextHits.length, 1);
  });
});

describe("crawl pagination — absolute same-origin next", () => {
  let restore: () => void;
  beforeEach(() => {
    const nextUrl = `https://api.firecrawl.dev/v2/crawl/job_123?next=abs`;
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: nextUrl },
      pages: { [nextUrl]: { data: [pageData("# B", "https://example.com/b")] } },
    });
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("follows an absolute same-origin next URL", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10 });
    assert.equal(result.documents.length, 2);
    assert.equal(result.pages, 2);
  });
});

describe("crawl pagination — relative next", () => {
  let restore: () => void;
  let requests: CapturedRequest[];
  beforeEach(() => {
    // Relative path resolved against the base URL by the provider via
    // `new URL(next, baseUrl)`. Key the mock by the exact resolved URL so the
    // test follows the same resolution semantics as the implementation.
    const rel = "/v2/crawl/job_123?next=rel";
    const resolved = new URL(rel, BASE).toString();
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: rel },
      pages: { [resolved]: { data: [pageData("# B", "https://example.com/b")] } },
    });
    requests = mock.requests;
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("resolves and follows a relative next URL against the base URL", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10 });
    assert.equal(result.documents.length, 2);
    assert.equal(result.pages, 2);
    const expectedResolved = new URL("/v2/crawl/job_123?next=rel", BASE).toString();
    const followed = requests.find((r) => r.url === expectedResolved);
    assert.ok(followed, "relative next must be resolved to the base-origin URL");
  });
});

describe("crawl pagination — cross-origin next rejected", () => {
  let restore: () => void;
  let requests: CapturedRequest[];
  beforeEach(() => {
    const cross = "https://evil.example.com/exfil?next=token";
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: cross },
      pages: {},
    });
    requests = mock.requests;
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("rejects a cross-origin next and never sends the bearer token there", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    await assert.rejects(
      () => provider.crawl("https://example.com", { limit: 10 }),
      /cross-origin/,
    );
    // No request may have been issued to the evil origin.
    const crossHits = requests.filter((r) => r.url.startsWith("https://evil.example.com"));
    assert.equal(crossHits.length, 0, "bearer token must not be sent cross-origin");
    // Sanity: the initial same-origin start + status requests did happen.
    assert.ok(requests.some((r) => r.url.endsWith("/crawl")), "start request should have been made");
  });
});

describe("crawl pagination — malformed paginated response", () => {
  it("throws when a followed next page returns a non-2xx error", async () => {
    const nextUrl = `${BASE}/crawl/job_123?next=bad`;
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: nextUrl },
      pages: { [nextUrl]: { httpStatus: 500, error: "boom" } },
    });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
      await assert.rejects(
        () => provider.crawl("https://example.com", { limit: 10 }),
        /Firecrawl 500/,
      );
    } finally {
      mock.restore();
    }
  });

  it("throws when a followed next page returns a success:false body", async () => {
    const nextUrl = `${BASE}/crawl/job_123?next=failed`;
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: nextUrl },
      pages: { [nextUrl]: { success: false, error: "pagination exploded" } },
    });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
      await assert.rejects(
        () => provider.crawl("https://example.com", { limit: 10 }),
        /pagination exploded/,
      );
    } finally {
      mock.restore();
    }
  });

  it("throws when next is an unresolvable URL", async () => {
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: "http://[::1:invalid" },
      pages: {},
    });
    try {
      const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
      await assert.rejects(
        () => provider.crawl("https://example.com", { limit: 10 }),
        /invalid 'next' URL|not a valid URL/i,
      );
    } finally {
      mock.restore();
    }
  });
});

describe("crawl pagination — credits/duration/timestamps preserved", () => {
  let restore: () => void;
  beforeEach(() => {
    const nextUrl = `${BASE}/crawl/job_123?next=meta`;
    const mock = installMock({
      firstPage: {
        data: [pageData("# A", "https://example.com/a")],
        next: nextUrl,
        creditsUsed: 5,
        durationMs: 1200,
        startedAt: "2026-07-10T00:00:00.000Z",
        finishedAt: "2026-07-10T00:00:01.200Z",
        expiresAt: "2026-07-10T01:00:00.000Z",
      },
      pages: {
        // Second page reports the cumulative creditsUsed (10) and same job
        // timestamps, mirroring how Firecrawl reports cumulative totals.
        [nextUrl]: {
          data: [pageData("# B", "https://example.com/b")],
          creditsUsed: 10,
          durationMs: 1300,
          startedAt: "2026-07-10T00:00:00.000Z",
          finishedAt: "2026-07-10T00:00:01.300Z",
          expiresAt: "2026-07-10T01:00:00.000Z",
        },
      },
    });
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("preserves credits, duration and timestamps from the status responses", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10 });
    assert.equal(result.documents.length, 2);
    assert.equal(result.pages, 2);
    // Cumulative value from the last page is preserved (not summed).
    assert.equal(result.creditsUsed, 10);
    assert.equal(result.durationMs, 1300);
    assert.equal(result.startedAt, "2026-07-10T00:00:00.000Z");
    assert.equal(result.finishedAt, "2026-07-10T00:00:01.300Z");
    assert.equal(result.expiresAt, "2026-07-10T01:00:00.000Z");
  });
});

describe("crawl pagination — provenance preserved on aggregated documents", () => {
  let restore: () => void;
  beforeEach(() => {
    const nextUrl = `${BASE}/crawl/job_123?next=prov`;
    const mock = installMock({
      firstPage: { data: [pageData("# A", "https://example.com/a")], next: nextUrl },
      pages: { [nextUrl]: { data: [pageData("# B", "https://example.com/b")] } },
    });
    restore = mock.restore;
  });
  afterEach(() => restore());

  it("every aggregated document carries provenance with requestedAt and maxAgeMs", async () => {
    const provider = createFirecrawlProvider({ apiKey: "test-key", pollIntervalMs: 1, pollTimeoutMs: 1000 });
    const result = await provider.crawl("https://example.com", { limit: 10, maxAgeMs: 0 });
    assert.equal(result.documents.length, 2);
    for (const doc of result.documents) {
      assert.ok(doc.provenance.requestedAt.length > 0);
      assert.equal(doc.provenance.maxAgeMs, 0);
    }
    // Distinct snapshot ids across pages (no overwrite).
    assert.notEqual(result.documents[0]?.id, result.documents[1]?.id);
  });
});

describe("CLI crawl command — compatibility and metadata in run output", () => {
  it("crawl follows pagination and preserves credits/duration/timestamps in the run record", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "cli-crawl-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--import", mockFirecrawlPath, cliPath, "crawl", "https://example.com", "--limit", "10"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            FIRECRAWL_API_KEY: "test-key",
            SCRAPE_AGENT_DATA_DIR: dataDir,
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      // Existing crawl command compatibility: documents are returned.
      assert.equal(payload.count, 2);
      assert.equal((payload.documents as unknown[]).length, 2);
      // RP-03: pagination/cost metadata is preserved in the CLI output.
      assert.equal(payload.pages, 2);
      assert.equal(payload.creditsUsed, 7);
      assert.equal(payload.durationMs, 1500);
      assert.equal(payload.startedAt, "2026-07-10T00:00:00.000Z");
      assert.equal(payload.finishedAt, "2026-07-10T00:00:01.500Z");
      assert.equal(payload.expiresAt, "2026-07-10T01:00:00.000Z");

      // The run record (runs.jsonl) preserves the same metadata.
      const runsPath = path.join(dataDir, "runs", "runs.jsonl");
      assert.ok(existsSync(runsPath), "run record must be written");
      const lines = readFileSync(runsPath, "utf8").trim().split("\n");
      const crawlRun = JSON.parse(lines[lines.length - 1]!) as { command: string; output: Record<string, unknown> };
      assert.equal(crawlRun.command, "crawl");
      assert.equal(crawlRun.output.pages, 2);
      assert.equal(crawlRun.output.creditsUsed, 7);
      assert.equal(crawlRun.output.expiresAt, "2026-07-10T01:00:00.000Z");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
