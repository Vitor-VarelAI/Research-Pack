import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFirecrawlProvider } from "../src/providers/firecrawl.js";

let restoreFetch: (() => void) | null = null;
const CONFIG_ENV_NAMES = ["FIRECRAWL_REQUEST_TIMEOUT_MS", "FIRECRAWL_MAX_RETRIES", "FIRECRAWL_RETRY_BASE_DELAY_MS"] as const;
let restoreEnv: (() => void) | null = null;

function installFetchMock(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
  globalThis.fetch = handler as typeof fetch;
}

function installConfigEnv(values: Partial<Record<(typeof CONFIG_ENV_NAMES)[number], string>>): void {
  const previous = new Map(CONFIG_ENV_NAMES.map((name) => [name, process.env[name]]));
  restoreEnv = () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    restoreEnv = null;
  };

  for (const name of CONFIG_ENV_NAMES) {
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }
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
    restoreEnv?.();
  });

  for (const status of [408, 429, 500, 502, 503, 504]) {
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
      maxRetries: 2,
      retryBaseDelayMs: 0,
      requestTimeoutMs: 5,
    });

    await assert.rejects(
      () => provider.scrape("https://example.com/page"),
      /Firecrawl request timed out after 5ms/,
    );
    assert.equal(calls, 1);
  });

  it("uses env retry config when provider config omits it", async () => {
    installConfigEnv({
      FIRECRAWL_MAX_RETRIES: "2",
      FIRECRAWL_RETRY_BASE_DELAY_MS: "0",
      FIRECRAWL_REQUEST_TIMEOUT_MS: "1000",
    });
    let calls = 0;
    installFetchMock(async () => {
      calls += 1;
      if (calls < 3) {
        return Response.json({ error: "temporarily overloaded" }, { status: 503 });
      }
      return scrapeSuccess();
    });

    const provider = createFirecrawlProvider({ apiKey: "test-key" });
    const doc = await provider.scrape("https://example.com/page");

    assert.equal(doc.markdown, "# OK");
    assert.equal(calls, 3);
  });

  it("rejects malformed env integer config before requests", async () => {
    installConfigEnv({ FIRECRAWL_REQUEST_TIMEOUT_MS: "10ms" });
    installFetchMock(async () => {
      throw new Error("fetch must not run for invalid config");
    });

    assert.throws(
      () => createFirecrawlProvider({ apiKey: "test-key" }),
      /FIRECRAWL_REQUEST_TIMEOUT_MS must be an integer/,
    );
  });

  it("rejects out-of-range env integer config before requests", async () => {
    installConfigEnv({ FIRECRAWL_MAX_RETRIES: "6" });
    installFetchMock(async () => {
      throw new Error("fetch must not run for invalid config");
    });

    assert.throws(
      () => createFirecrawlProvider({ apiKey: "test-key" }),
      /FIRECRAWL_MAX_RETRIES must be an integer/,
    );
  });
});
