import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  SENSITIVE_CATEGORIES,
  NON_SENSITIVE_MIN_ANCHORS,
  SENSITIVE_MIN_ANCHORS,
  SourceGateResultSchema,
  evaluateSourceGate,
  parseSourceGateResult,
  validateSourceGateFile,
  type SourceGateAnchor,
} from "../src/schemas/source-gate.js";
import {
  nonSensitivePassRaw,
  twoSourcesBlockRaw,
  sensitiveThreeBlockRaw,
  sensitiveFourPassRaw,
  invalidJsonString,
  twoSourcesForgedPassRaw,
  sensitiveThreeForgedPassRaw,
} from "./fixtures/source-gate-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

const anchor = (host: string): SourceGateAnchor => ({
  sourceName: host,
  sourceUrl: `https://${host}/`,
  sourceType: "official",
  confirmedClaims: ["claim"],
  unconfirmedClaims: [],
  interpretationRisk: "No obvious interpretation risk.",
});

describe("source gate schema", () => {
  it("accepts a valid non-sensitive pass result", () => {
    const parsed = parseSourceGateResult(nonSensitivePassRaw);
    assert.equal(parsed.pass, true);
    assert.equal(parsed.diagnosisAllowed, true);
    assert.equal(parsed.minimumAnchorsFound, 3);
    assert.equal(parsed.sensitiveCategories.length, 0);
  });

  it("accepts a valid two-source block result", () => {
    const parsed = parseSourceGateResult(twoSourcesBlockRaw);
    assert.equal(parsed.pass, false);
    assert.equal(parsed.diagnosisAllowed, false);
    assert.equal(parsed.minimumAnchorsFound, 2);
  });

  it("rejects invalid source-gate JSON (not an object)", () => {
    assert.throws(() => parseSourceGateResult("not-an-object"));
  });

  it("rejects an unknown sensitive category", () => {
    const bad = { ...nonSensitivePassRaw, sensitiveCategories: ["made-up"] };
    assert.throws(() => parseSourceGateResult(bad));
  });

  it("rejects a result missing the pass field", () => {
    const { pass: _pass, ...rest } = nonSensitivePassRaw;
    void _pass;
    assert.throws(() => parseSourceGateResult(rest));
  });

  it("rejects adversarial JSON with 2 anchors but pass=true", () => {
    assert.throws(() => parseSourceGateResult(twoSourcesForgedPassRaw), /minimumAnchorsFound|pass|diagnosisAllowed/);
  });

  it("rejects adversarial sensitive JSON with 3 anchors but pass=true", () => {
    assert.throws(() => parseSourceGateResult(sensitiveThreeForgedPassRaw), /needsExtraAnchor|pass|diagnosisAllowed/);
  });
});

describe("source gate evaluation logic", () => {
  it("0-2 anchors: pass=false, diagnosisAllowed=false", () => {
    for (const count of [0, 1, 2]) {
      const result = evaluateSourceGate({ anchors: Array.from({ length: count }, () => anchor("h.com")) });
      assert.equal(result.pass, false, `count=${count}`);
      assert.equal(result.diagnosisAllowed, false, `count=${count}`);
      assert.equal(result.minimumAnchorsFound, count);
    }
  });

  it("3 anchors pass for non-sensitive topics", () => {
    const result = evaluateSourceGate({
      anchors: [anchor("a.com"), anchor("b.com"), anchor("c.com")],
    });
    assert.equal(result.pass, true);
    assert.equal(result.diagnosisAllowed, true);
    assert.equal(result.needsExtraAnchor, false);
  });

  it("sensitive topic requires 4 anchors (3 blocks)", () => {
    const result = evaluateSourceGate({
      anchors: [anchor("a.com"), anchor("b.com"), anchor("c.com")],
      sensitiveCategories: ["privacy"],
    });
    assert.equal(result.pass, false);
    assert.equal(result.diagnosisAllowed, false);
    assert.equal(result.needsExtraAnchor, true);
    assert.equal(result.minimumAnchorsFound, 3);
  });

  it("sensitive topic passes with 4 anchors", () => {
    const result = evaluateSourceGate({
      anchors: [anchor("a.com"), anchor("b.com"), anchor("c.com"), anchor("d.com")],
      sensitiveCategories: ["privacy", "security"],
    });
    assert.equal(result.pass, true);
    assert.equal(result.diagnosisAllowed, true);
    assert.equal(result.sensitiveCategories.length, 2);
  });

  it("SENSITIVE_CATEGORIES matches the project-defined set", () => {
    assert.deepEqual(
      [...SENSITIVE_CATEGORIES],
      ["privacy", "copyright", "security", "financial claims", "benchmarks", "legal claims", "superlatives"],
    );
  });

  it("threshold constants are 3 and 4", () => {
    assert.equal(NON_SENSITIVE_MIN_ANCHORS, 3);
    assert.equal(SENSITIVE_MIN_ANCHORS, 4);
  });

  it("evaluateSourceGate output is always schema-valid", () => {
    const zero = evaluateSourceGate({ anchors: [] });
    assert.doesNotThrow(() => SourceGateResultSchema.parse(zero));
  });
});

describe("validateSourceGateFile", () => {
  it("reads and validates a passing file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sg-pass-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(nonSensitivePassRaw));
      const result = validateSourceGateFile(file);
      assert.equal(result.pass, true);
      assert.equal(result.diagnosisAllowed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on invalid JSON file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sg-invalid-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, invalidJsonString);
      assert.throws(() => validateSourceGateFile(file), SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on schema-invalid file (missing pass)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sg-schema-"));
    try {
      const file = path.join(dir, "gate.json");
      const { pass: _pass, ...rest } = nonSensitivePassRaw;
      void _pass;
      writeFileSync(file, JSON.stringify(rest));
      assert.throws(() => validateSourceGateFile(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the sensitive four-pass fixture", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sg-sens4-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(sensitiveFourPassRaw));
      const result = validateSourceGateFile(file);
      assert.equal(result.pass, true);
      assert.equal(result.sensitiveCategories[0], "privacy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI source-gate --validate", () => {
  it("exits 0 and prints parsed result for a passing gate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-pass-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(nonSensitivePassRaw));
      const result = runCli(["source-gate", "--validate", file]);
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout) as { pass: boolean; diagnosisAllowed: boolean };
      assert.equal(payload.pass, true);
      assert.equal(payload.diagnosisAllowed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero for a blocking gate (pass=false)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-block-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(twoSourcesBlockRaw));
      const result = runCli(["source-gate", "--validate", file]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /BLOCKED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero for invalid JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-invalid-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, invalidJsonString);
      const result = runCli(["source-gate", "--validate", file]);
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero for sensitive topic with only 3 anchors", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-sens3-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(sensitiveThreeBlockRaw));
      const result = runCli(["source-gate", "--validate", file]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /BLOCKED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero for adversarial JSON with 2 anchors but pass=true", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-forged-"));
    try {
      const file = path.join(dir, "gate.json");
      writeFileSync(file, JSON.stringify(twoSourcesForgedPassRaw));
      const result = runCli(["source-gate", "--validate", file]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /minimumAnchorsFound|pass|diagnosisAllowed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
