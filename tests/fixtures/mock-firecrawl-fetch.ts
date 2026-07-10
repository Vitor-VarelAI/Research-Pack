/**
 * Test-only mock for Firecrawl HTTP calls. No network, no paid providers.
 *
 * Records each request's URL and parsed JSON body to the file path in
 * `MOCK_FIRECRAWL_RECORD` (a JSON array appended in-place), so tests can
 * assert that scrape/agent payloads include `maxAge`.
 *
 * The response shape mirrors Firecrawl v2 enough for the provider parser and
 * includes optional cache-provenance fields (`fromCache`, `cacheState`,
 * `metadata.scrapedAt`) when `MOCK_FIRECRAWL_CACHE` is set to `cached` or
 * `fresh`.
 *
 * Crawl pagination is mocked with a fixed two-page sequence (same-origin
 * absolute `next`) so CLI `crawl` tests can assert metadata preservation
 * without a paid provider.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const recordPath = process.env.MOCK_FIRECRAWL_RECORD;
const cacheMode = process.env.MOCK_FIRECRAWL_CACHE ?? "none";
const baseUrl = process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2";

function cacheFields(): Record<string, unknown> {
  if (cacheMode === "cached") return { fromCache: true, cacheState: "hit" };
  if (cacheMode === "fresh") return { fromCache: false, cacheState: "miss" };
  return {};
}

function record(url: string, body: unknown): void {
  if (!recordPath) return;
  const existing = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as unknown[]) : [];
  existing.push({ url, body });
  writeFileSync(recordPath, JSON.stringify(existing));
}

function crawlDoc(n: number) {
  return {
    markdown: `# Mocked crawl page ${n}`,
    html: `<h1>page ${n}</h1>`,
    links: [`https://example.com/crawl-${n}`],
    metadata: { sourceURL: `https://example.com/crawl-${n}`, title: `page ${n}`, scrapedAt: "2026-07-10T00:00:00.000Z" },
  };
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
  record(url, parsedBody);

  if (url.endsWith("/scrape")) {
    return Response.json({
      success: true,
      ...cacheFields(),
      data: {
        markdown: "# Mocked page\n\nContent.",
        html: "<h1>Mocked page</h1>",
        links: ["https://example.com/a"],
        metadata: {
          sourceURL: "https://example.com/page",
          title: "Mocked page",
          scrapedAt: "2026-07-10T00:00:00.000Z",
        },
        json: { answer: "mocked answer", facts: [], sources: [], confidence: "medium" },
      },
    });
  }

  if (url.endsWith("/agent")) {
    return Response.json({ success: true, data: { answer: "mocked agent answer", facts: [], sources: [], confidence: "medium" } });
  }

  // Crawl start.
  if (url.endsWith("/crawl") && method === "POST") {
    return Response.json({ success: true, id: "mock_crawl_job" });
  }

  // Crawl status: first page (same-origin absolute next to page 2).
  if (url.endsWith("/crawl/mock_crawl_job")) {
    return Response.json({
      success: true,
      status: "completed",
      completed: 1,
      total: 2,
      creditsUsed: 7,
      durationMs: 1500,
      startedAt: "2026-07-10T00:00:00.000Z",
      finishedAt: "2026-07-10T00:00:01.500Z",
      expiresAt: "2026-07-10T01:00:00.000Z",
      next: `${baseUrl}/crawl/mock_crawl_job?next=page2`,
      data: [crawlDoc(1)],
    });
  }

  // Crawl status: second page (no next).
  if (url.includes("next=page2")) {
    return Response.json({
      success: true,
      status: "completed",
      completed: 2,
      total: 2,
      creditsUsed: 7,
      durationMs: 1500,
      startedAt: "2026-07-10T00:00:00.000Z",
      finishedAt: "2026-07-10T00:00:01.500Z",
      expiresAt: "2026-07-10T01:00:00.000Z",
      data: [crawlDoc(2)],
    });
  }

  return Response.json({ error: "not found" }, { status: 404 });
};
