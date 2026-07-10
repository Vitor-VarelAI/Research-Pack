import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getHnTopStories, resolveHnConcurrency } from "../src/hn.js";

/**
 * RP-04: HN item requests must be capped at the configured concurrency limit.
 * `getHnTopStories` previously fired `Promise.all` over every top-story id,
 * so `--top 120` would issue 120 simultaneous requests. The cap must bound
 * the maximum observed in-flight count.
 *
 * No network, no paid providers. An in-process fetch mock records concurrency.
 */

const originalFetch = globalThis.fetch;

function installCountingMock(options: { itemDelayMs?: number } = {}) {
  const itemDelayMs = options.itemDelayMs ?? 5;
  let inFlight = 0;
  let maxInFlight = 0;
  let itemRequestCount = 0;

  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/topstories.json")) {
      // 30 top-story ids.
      const ids = Array.from({ length: 30 }, (_, i) => 1000 + i);
      return Response.json(ids);
    }

    const match = url.match(/\/item\/(\d+)\.json$/);
    if (match) {
      itemRequestCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, itemDelayMs));
        const id = Number(match[1]);
        return Response.json({
          id,
          type: "story",
          title: `Story ${id}`,
          url: `https://example.com/${id}`,
          score: 10,
          descendants: 0,
        });
      } finally {
        inFlight -= 1;
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    stats: () => ({ maxInFlight, itemRequestCount }),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("HN concurrency cap (RP-04)", () => {
  let restore: () => void;

  beforeEach(() => {
    // ensure env override does not leak into tests that assert explicit caps
    delete process.env.HN_CONCURRENCY;
  });

  afterEach(() => {
    if (restore) restore();
  });

  it("never exceeds the configured concurrency limit (limit=4)", async () => {
    const mock = installCountingMock();
    restore = mock.restore;
    const stories = await getHnTopStories(30, 4);
    const { maxInFlight, itemRequestCount } = mock.stats();
    assert.equal(stories.length, 30);
    assert.equal(itemRequestCount, 30, "every top-story id fetched exactly once");
    assert.ok(maxInFlight <= 4, `maxInFlight ${maxInFlight} exceeded limit 4`);
    assert.ok(maxInFlight >= 2, `maxInFlight ${maxInFlight} too low; concurrency not exercised`);
  });

  it("never exceeds the configured concurrency limit (limit=8)", async () => {
    const mock = installCountingMock();
    restore = mock.restore;
    await getHnTopStories(30, 8);
    const { maxInFlight } = mock.stats();
    assert.ok(maxInFlight <= 8, `maxInFlight ${maxInFlight} exceeded limit 8`);
    assert.ok(maxInFlight >= 4, `maxInFlight ${maxInFlight} too low; concurrency not exercised`);
  });

  it("a smaller limit observes strictly lower (or equal) peak than a larger limit", async () => {
    const mockSmall = installCountingMock();
    await getHnTopStories(30, 2);
    const smallPeak = mockSmall.stats().maxInFlight;
    mockSmall.restore();

    const mockLarge = installCountingMock();
    await getHnTopStories(30, 10);
    const largePeak = mockLarge.stats().maxInFlight;
    mockLarge.restore();

    assert.ok(smallPeak <= largePeak, `small peak ${smallPeak} should be <= large peak ${largePeak}`);
    assert.ok(smallPeak <= 2, `small peak ${smallPeak} exceeded limit 2`);
    assert.ok(largePeak <= 10, `large peak ${largePeak} exceeded limit 10`);
  });

  it("limit=1 serializes all requests (maxInFlight === 1)", async () => {
    const mock = installCountingMock({ itemDelayMs: 1 });
    restore = mock.restore;
    await getHnTopStories(10, 1);
    const { maxInFlight } = mock.stats();
    assert.equal(maxInFlight, 1, `maxInFlight ${maxInFlight} should be exactly 1`);
  });

  it("resolveHnConcurrency defaults to 8 and clamps env overrides", () => {
    delete process.env.HN_CONCURRENCY;
    assert.equal(resolveHnConcurrency(), 8);
    process.env.HN_CONCURRENCY = "3";
    assert.equal(resolveHnConcurrency(), 3);
    process.env.HN_CONCURRENCY = "0";
    assert.equal(resolveHnConcurrency(), 8, "out-of-range env falls back to default");
    process.env.HN_CONCURRENCY = "9999";
    assert.equal(resolveHnConcurrency(), 8, "out-of-range env falls back to default");
    process.env.HN_CONCURRENCY = "not-a-number";
    assert.equal(resolveHnConcurrency(), 8);
    process.env.HN_CONCURRENCY = "3foo";
    assert.equal(resolveHnConcurrency(), 8, "partial integer env falls back to default");
    delete process.env.HN_CONCURRENCY;
  });
});
