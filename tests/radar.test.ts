import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRadarReportFromHn, detectRadarSignals, type RadarItem, type RadarSignal } from "../src/radar.js";
import type { HnStory } from "../src/hn.js";

/**
 * RP-04: radar signal detection must not produce false positives from short
 * acronyms embedded inside larger words, while still detecting UI, API, EU,
 * US and PR as standalone tokens.
 *
 * No network, no paid providers. `detectRadarSignals` is a pure function.
 */

describe("radar false positives (RP-04)", () => {
  it("does not flag 'Build' as UI", () => {
    const signals = detectRadarSignals("Build faster with this compiler");
    assert.ok(!signals.includes("ui-experiment"), `signals: ${signals.join(",")}`);
  });

  it("does not flag 'Postgres' as OS / api-distribution", () => {
    const signals = detectRadarSignals("Postgres performance tuning");
    assert.ok(!signals.includes("api-distribution"), `signals: ${signals.join(",")}`);
  });

  it("does not flag 'Rust' as US / infrastructure-geopolitics", () => {
    const signals = detectRadarSignals("Rust memory safety");
    assert.ok(!signals.includes("infrastructure-geopolitics"), `signals: ${signals.join(",")}`);
  });

  it("does not flag 'programming' as PR / market-strategy", () => {
    const signals = detectRadarSignals("programming language design");
    assert.ok(!signals.includes("market-strategy"), `signals: ${signals.join(",")}`);
  });

  it("does not flag 'happy' or 'mapping' as app / api-distribution", () => {
    assert.ok(!detectRadarSignals("happy day").includes("api-distribution"));
    assert.ok(!detectRadarSignals("mapping tool").includes("api-distribution"));
  });

  it("does not flag 'OpenAI' internals as standalone AI token (boundary check)", () => {
    // 'OpenAI' is detected via the OpenAI alternative, not via \bAI\b inside it.
    // A word like 'brain' must not trip \bAI\b.
    const signals = detectRadarSignals("brain training");
    assert.ok(!signals.includes("ai-tool"), `signals: ${signals.join(",")}`);
  });
});

describe("radar true positives (RP-04)", () => {
  it("detects standalone UI", () => {
    assert.ok(detectRadarSignals("A new UI library").includes("ui-experiment"));
  });

  it("detects standalone API", () => {
    assert.ok(detectRadarSignals("OpenAI API workflow").includes("api-distribution"));
  });

  it("detects standalone EU", () => {
    assert.ok(detectRadarSignals("EU AI Act regulation").includes("infrastructure-geopolitics"));
  });

  it("detects standalone US", () => {
    assert.ok(detectRadarSignals("US export controls on chips").includes("infrastructure-geopolitics"));
  });

  it("detects standalone PR", () => {
    assert.ok(detectRadarSignals("a PR stunt by the vendor").includes("market-strategy"));
  });
});

describe("radar sorting and scoring determinism (RP-04)", () => {
  function makeStory(title: string, rank: number, score: number, comments: number, url: string): HnStory {
    return {
      id: rank,
      title,
      url,
      hnUrl: `https://news.ycombinator.com/item?id=${rank}`,
      score,
      commentsCount: comments,
      rank,
      aiSignals: [],
    };
  }

  const stories: HnStory[] = [
    makeStory("Show HN: OpenAI API workflow for designers", 1, 200, 80, "https://example.com/a"),
    makeStory("SQLite release notes", 2, 20, 3, "https://example.com/sqlite"),
    makeStory("A boring weather forecast", 3, 5, 1, "https://example.com/weather"),
  ];

  it("produces identical item ordering, signals and scores across runs", () => {
    const a = buildRadarReportFromHn(stories, 10);
    const b = buildRadarReportFromHn(stories, 10);
    // generatedAt differs run-to-run; compare items only.
    assert.deepEqual(a.items, b.items);
  });

  it("sorts by totalScore descending (higher signal story ranks first regardless of HN rank)", () => {
    const report = buildRadarReportFromHn(stories, 10);
    const titles = report.items.map((item) => item.title);
    // The OpenAI story has the most signals / highest score; the weather story
    // has none and is filtered out entirely.
    assert.ok(titles.includes("Show HN: OpenAI API workflow for designers"));
    assert.ok(!titles.includes("A boring weather forecast"));
    const openAiIdx = titles.indexOf("Show HN: OpenAI API workflow for designers");
    const sqliteIdx = titles.indexOf("SQLite release notes");
    assert.ok(openAiIdx < sqliteIdx, "higher-scoring story must sort first");
  });

  it("totalScore is the sum of all scores except verificationNeed", () => {
    const report = buildRadarReportFromHn(stories, 10);
    for (const item of report.items as RadarItem[]) {
      const expected = Object.entries(item.scores)
        .filter(([key]) => key !== "verificationNeed")
        .reduce((sum, [, v]) => sum + v, 0);
      assert.equal(item.totalScore, expected);
    }
  });

  it("limit caps the number of returned items", () => {
    const report = buildRadarReportFromHn(stories, 1);
    assert.equal(report.items.length, 1);
  });

  it("detectRadarSignals returns each signal at most once", () => {
    const signals = detectRadarSignals("OpenAI API workflow API API");
    const apiCount = signals.filter((s: RadarSignal) => s === "api-distribution").length;
    assert.equal(apiCount, 1);
  });
});
