import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");
const mockFetchPath = path.join(repoRoot, "tests", "fixtures", "mock-hn-fetch.ts");

describe("CLI smoke tests", () => {
  it("prints top-level help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: scrape-agent/);
    assert.match(result.stdout, /radar-hn/);
    assert.match(result.stdout, /hn-ai/);
  });

  it("runs radar-hn against local HN fixtures", () => {
    const result = runCli(["radar-hn", "--top", "2", "--limit", "1"], { mockHn: true });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { mode: string; items: Array<{ title: string }> };
    assert.equal(payload.mode, "collect-wide");
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0]?.title, "Show HN: OpenAI API workflow for designers");
  });

  it("runs hn-ai against local HN fixtures", () => {
    const result = runCli(["hn-ai", "--top", "2", "--limit", "1", "--neighbors", "2"], { mockHn: true });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { aiStories: Array<{ id: number }>; sameFrontpage: unknown[] };
    assert.equal(payload.aiStories.length, 1);
    assert.equal(payload.aiStories[0]?.id, 101);
    assert.equal(payload.sameFrontpage.length, 2);
  });
});

function runCli(args: string[], options: { mockHn?: boolean } = {}): { status: number | null; stdout: string; stderr: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "scrape-agent-test-"));
  const nodeArgs = ["--import", "tsx"];
  if (options.mockHn) nodeArgs.push("--import", mockFetchPath);
  nodeArgs.push(cliPath, ...args);

  try {
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        SCRAPE_AGENT_DATA_DIR: dataDir,
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
