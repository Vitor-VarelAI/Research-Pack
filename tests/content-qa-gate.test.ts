import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  nonSensitivePassRaw,
  twoSourcesBlockRaw,
  invalidJsonString,
} from "./fixtures/source-gate-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * These tests verify the source sufficiency gate enforcement in
 * content-qa.sh using only local mocks. No paid providers are called.
 *
 * Test seams:
 * - SOURCE_GATE_RESULT_FILE: feeds a pre-existing gate JSON so fact-check.sh
 *   (which calls DeepSeek) is never invoked.
 * - SCRAPE_AGENT_BIN: points to the repo-local tsx loader and `src/cli.ts` so
 *   a fresh checkout can run `npm test` before `npm run build`, even though
 *   content-qa.sh itself runs from a temporary cwd.
 *
 * content-qa.sh calls linters via the relative path `scripts/<name>.sh`. We
 * run the script from a temp cwd whose `scripts/` directory contains stub
 * lint scripts that write a marker file when called. This proves whether
 * linters were reached without calling any paid provider.
 */

describe("content-qa.sh source gate enforcement", () => {
  it("blocks downstream linters when pass=false", () => {
    const result = runContentQa({ gateJson: twoSourcesBlockRaw });
    assert.notEqual(result.status, 0, "content-qa.sh should exit non-zero when the gate blocks");
    assert.match(result.stderr, /Source gate did not approve|FAILED source gate validation|BLOCKED/i);
    assert.equal(
      result.lintCalls,
      0,
      `linters must not run when gate blocks, but got ${result.lintCalls} calls`,
    );
  });

  it("blocks downstream linters when gate JSON is invalid", () => {
    const result = runContentQa({ gateJsonRaw: invalidJsonString });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source gate/i);
    assert.equal(result.lintCalls, 0, "linters must not run on invalid gate JSON");
  });

  it("runs downstream linters when the gate approves (pass=true)", () => {
    const result = runContentQa({ gateJson: nonSensitivePassRaw });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.lintCalls >= 2,
      `expected at least 2 lint calls (deepseek + zai), got ${result.lintCalls}`,
    );
    assert.ok(existsSync(path.join(result.outDir, "source-gate-validated.json")));
  });

  it("writes the validated gate result on approval", () => {
    const result = runContentQa({ gateJson: nonSensitivePassRaw });
    assert.equal(result.status, 0, result.stderr);
    const validated = JSON.parse(
      readFileSync(path.join(result.outDir, "source-gate-validated.json"), "utf8"),
    ) as { pass: boolean; diagnosisAllowed: boolean };
    assert.equal(validated.pass, true);
    assert.equal(validated.diagnosisAllowed, true);
  });
});

type ContentQaResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
  lintCalls: number;
};

function runContentQa(options: { gateJson?: unknown; gateJsonRaw?: string }): ContentQaResult {
  const tmp = mkdtempSync(path.join(tmpdir(), "qa-gate-"));
  const outDir = path.join(tmp, "out");
  const draftFile = path.join(tmp, "draft.md");
  const gateFile = path.join(tmp, "fact-check.json");
  const lintMarker = path.join(tmp, "lint-calls.txt");

  // Temp cwd with a scripts/ dir containing stubs. content-qa.sh resolves
  // `scripts/editorial-lint.sh` relative to cwd, so these stubs intercept.
  const workCwd = path.join(tmp, "work");
  const workScripts = path.join(workCwd, "scripts");
  mkdirSync(workScripts, { recursive: true });
  copyFileSync(path.join(repoRoot, "scripts", "content-qa.sh"), path.join(workCwd, "scripts", "content-qa.sh"));

  writeFileSync(draftFile, "# Test draft\n\nSome content.\n");

  if (options.gateJsonRaw !== undefined) {
    writeFileSync(gateFile, options.gateJsonRaw);
  } else {
    writeFileSync(gateFile, JSON.stringify(options.gateJson));
  }

  // Stub editorial-lint.sh: record a call and exit 0 with fake JSON.
  const lintStub = `#!/usr/bin/env bash
echo "lint-call" >> "${lintMarker}"
echo '{"issues":[]}'
`;
  writeFileSync(path.join(workScripts, "editorial-lint.sh"), lintStub, { mode: 0o755 });

  // Stub fact-check.sh: should NOT be called when SOURCE_GATE_RESULT_FILE is set.
  writeFileSync(path.join(workScripts, "fact-check.sh"), `#!/usr/bin/env bash\necho '{"pass":true}'\n`, { mode: 0o755 });

  // Stub ptpt-lint.sh to avoid HF dependency.
  writeFileSync(path.join(workScripts, "ptpt-lint.sh"), `#!/usr/bin/env bash\necho '{"ptpt":"ok"}'\n`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOURCE_GATE_RESULT_FILE: gateFile,
    SCRAPE_AGENT_BIN: "node --import " + path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs") + " " + path.join(repoRoot, "src", "cli.ts"),
    HF_TOKEN: "",
  };

  const result = spawnSync("bash", [path.join(workCwd, "scripts", "content-qa.sh"), draftFile, outDir], {
    cwd: workCwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });

  let lintCalls = 0;
  if (existsSync(lintMarker)) {
    lintCalls = readFileSync(lintMarker, "utf8").trim().split("\n").filter(Boolean).length;
  }

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outDir, lintCalls };
}
