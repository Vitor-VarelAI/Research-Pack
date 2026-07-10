import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const mockThrowPath = path.join(repoRoot, "tests", "fixtures", "mock-fetch-throw.ts");
const mockHnPath = path.join(repoRoot, "tests", "fixtures", "mock-hn-fetch.ts");
const mockFirecrawlPath = path.join(repoRoot, "tests", "fixtures", "mock-firecrawl-fetch.ts");

/**
 * RP-04: every CLI integer option must be validated as a full integer string
 * at option-parse time, before any HN/provider request. Invalid values
 * (negative, zero where zero is meaningless, partial like `10foo`, excessive)
 * are rejected. The `mock-fetch-throw` fixture fails loudly if any request
 * escapes, proving rejection happens before the action runs.
 */

function runCli(
  args: string[],
  options: { importMock?: string; extraEnv?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "scrape-agent-int-"));
  const nodeArgs = ["--import", "tsx"];
  if (options.importMock) nodeArgs.push("--import", options.importMock);
  nodeArgs.push(cliPath, ...args);
  try {
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        SCRAPE_AGENT_DATA_DIR: dataDir,
        ...(options.extraEnv ?? {}),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const VALIDATION_ERROR = /Invalid integer|below minimum|exceeds maximum|out of range/;
const FETCH_LEAK = /fetch should not be called/;

function assertRejected(result: { status: number | null; stdout: string; stderr: string }, label: string): void {
  assert.notEqual(result.status, 0, `${label}: expected non-zero exit`);
  assert.match(result.stderr, VALIDATION_ERROR, `${label}: expected validation error in stderr`);
  assert.ok(!FETCH_LEAK.test(result.stderr), `${label}: a fetch call leaked past validation`);
}

describe("CLI integer validation (RP-04) — invalid options reject before requests", () => {
  it("radar-hn --top 0 (zero) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--top", "0"], { importMock: mockThrowPath }), "radar-hn --top 0");
  });

  it("radar-hn --top -5 (negative) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--top", "-5"], { importMock: mockThrowPath }), "radar-hn --top -5");
  });

  it("radar-hn --top 10foo (partial) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--top", "10foo"], { importMock: mockThrowPath }), "radar-hn --top 10foo");
  });

  it("radar-hn --top 9999 (excessive) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--top", "9999"], { importMock: mockThrowPath }), "radar-hn --top 9999");
  });

  it("radar-hn --limit 0 (zero) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--limit", "0"], { importMock: mockThrowPath }), "radar-hn --limit 0");
  });

  it("radar-hn --limit abc (non-numeric) is rejected", () => {
    assertRejected(runCli(["radar-hn", "--limit", "abc"], { importMock: mockThrowPath }), "radar-hn --limit abc");
  });

  it("hn-ai --neighbors -1 (negative) is rejected", () => {
    assertRejected(runCli(["hn-ai", "--neighbors", "-1"], { importMock: mockThrowPath }), "hn-ai --neighbors -1");
  });

  it("hn-ai --top 501 (excessive) is rejected", () => {
    assertRejected(runCli(["hn-ai", "--top", "501"], { importMock: mockThrowPath }), "hn-ai --top 501");
  });

  it("scrape --max-age -1 (negative) is rejected", () => {
    assertRejected(
      runCli(["scrape", "https://example.com/page", "--max-age", "-1"], { importMock: mockThrowPath }),
      "scrape --max-age -1",
    );
  });

  it("scrape --max-age 10foo (partial) is rejected", () => {
    assertRejected(
      runCli(["scrape", "https://example.com/page", "--max-age", "10foo"], { importMock: mockThrowPath }),
      "scrape --max-age 10foo",
    );
  });

  it("scrape --max-age 99999999999999999 (excessive) is rejected", () => {
    assertRejected(
      runCli(["scrape", "https://example.com/page", "--max-age", "99999999999999999"], { importMock: mockThrowPath }),
      "scrape --max-age excessive",
    );
  });

  it("crawl --limit 0 (zero) is rejected", () => {
    assertRejected(runCli(["crawl", "https://example.com", "--limit", "0"], { importMock: mockThrowPath }), "crawl --limit 0");
  });

  it("crawl --limit 1001 (excessive) is rejected", () => {
    assertRejected(
      runCli(["crawl", "https://example.com", "--limit", "1001"], { importMock: mockThrowPath }),
      "crawl --limit 1001",
    );
  });

  it("crawl --wait-for -10 (negative) is rejected", () => {
    assertRejected(
      runCli(["crawl", "https://example.com", "--wait-for", "-10"], { importMock: mockThrowPath }),
      "crawl --wait-for -10",
    );
  });

  it("map --limit 0 (zero) is rejected", () => {
    assertRejected(runCli(["map", "https://example.com", "--limit", "0"], { importMock: mockThrowPath }), "map --limit 0");
  });
});

describe("CLI integer validation (RP-04) — valid options still work", () => {
  it("radar-hn --top 2 --limit 1 succeeds against local HN fixtures", () => {
    const result = runCli(["radar-hn", "--top", "2", "--limit", "1"], { importMock: mockHnPath });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { items: unknown[] };
    assert.equal(payload.items.length, 1);
  });

  it("hn-ai --neighbors 0 is accepted (zero is meaningful for neighbors)", () => {
    const result = runCli(["hn-ai", "--top", "2", "--limit", "1", "--neighbors", "0"], { importMock: mockHnPath });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { aiStories: unknown[]; sameFrontpage: unknown[] };
    assert.equal(payload.aiStories.length, 1);
    assert.equal(payload.sameFrontpage.length, 0);
  });

  it("scrape --max-age 0 is accepted (force fresh) against local Firecrawl mock", () => {
    const result = runCli(["scrape", "https://example.com/page", "--max-age", "0"], {
      importMock: mockFirecrawlPath,
      extraEnv: { FIRECRAWL_API_KEY: "test-key" },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it("crawl --limit 10 succeeds against local Firecrawl mock", () => {
    const result = runCli(["crawl", "https://example.com", "--limit", "10"], {
      importMock: mockFirecrawlPath,
      extraEnv: { FIRECRAWL_API_KEY: "test-key" },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});
