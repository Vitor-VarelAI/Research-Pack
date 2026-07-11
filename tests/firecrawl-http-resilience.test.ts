import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFirecrawlProvider } from "../src/providers/firecrawl.js";

let restoreFetch: (() => void) | null = null;

function installFetchMock(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
  globalThis.fetch = handler as typeof fetch;
}

function scrapeSuccess(): Response {
  return Response.json({
    success: true,
    data: {
      markdown: "# OK",
      html: "<h1>OK</h1>",
      links: [],
      metadata: { sourceURL: "https://example.com/page", title: "OK" },
    },
  });
}

describe("Firecrawl HTTP resilience", () => {
  afterEach(() => {
    restoreFetch?.();
  });

  for (const status of [408, 429, 500]) {
    it(`retries transient Firecrawl ${status} responses`, async () => {
      let calls = 0;
      installFetchMock(async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json({ error: "try again" }, { status });
        }
        return scrapeSuccess();
      });

      const provider = createFirecrawlProvider({
        apiKey: "test-key",
        maxRetries: 1,
        retryBaseDelayMs: 0,
        requestTimeoutMs: 1_000,
      });

      const doc = await provider.scrape("https://example.com/page");

      assert.equal(doc.markdown, "# OK");
      assert.equal(calls, 2);
    });
  }

  it("stops after the configured retry cap", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls += 1;
      return Response.json({ error: "still busy" }, { status: 503 });
    });

    const provider = createFirecrawlProvider({
      apiKey: "test-key",
      maxRetries: 1,
      retryBaseDelayMs: 0,
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(
      () => provider.scrape("https://example.com/page"),
      /Firecrawl 503: still busy/,
    );
    assert.equal(calls, 2);
  });

  it("does not retry non-transient Firecrawl errors", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls += 1;
      return Response.json({ error: "bad payload" }, { status: 400 });
    });

    const provider = createFirecrawlProvider({
      apiKey: "test-key",
      maxRetries: 2,
      retryBaseDelayMs: 0,
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(
      () => provider.scrape("https://example.com/page"),
      /Firecrawl 400: bad payload/,
    );
    assert.equal(calls, 1);
  });

  it("aborts a hung Firecrawl request at the configured timeout", async () => {
    let calls = 0;
    installFetchMock((_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const provider = createFirecrawlProvider({
      apiKey: "test-key",
      maxRetries: 0,
      retryBaseDelayMs: 0,
      requestTimeoutMs: 5,
    });

    await assert.rejects(
      () => provider.scrape("https://example.com/page"),
      /Firecrawl request timed out after 5ms/,
    );
    assert.equal(calls, 1);
  });
});
