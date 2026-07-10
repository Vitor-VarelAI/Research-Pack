/**
 * Local fixtures for source gate tests. No network calls.
 *
 * These mirror the JSON shape documented in `prompts/fact-check.md` and
 * validated by `src/schemas/source-gate.ts`.
 */
import type { SourceGateResult } from "../../src/schemas/source-gate.js";

const anchor = (sourceName: string, host: string): {
  sourceName: string;
  sourceUrl: string;
  sourceType: "official" | "journalistic" | "technical" | "policy" | "market" | "other";
  confirmedClaims: string[];
  unconfirmedClaims: string[];
  interpretationRisk: string;
} => ({
  sourceName,
  sourceUrl: `https://${host}/`,
  sourceType: "official",
  confirmedClaims: ["claim a"],
  unconfirmedClaims: [],
  interpretationRisk: "No obvious interpretation risk.",
});

/** Three valid anchors, no sensitive categories — should pass. */
export const nonSensitivePassRaw: SourceGateResult = {
  pass: true,
  minimumAnchorsFound: 3,
  needsExtraAnchor: false,
  sensitiveCategories: [],
  anchors: [
    anchor("Official Blog", "blog.example.com"),
    anchor("TechCrunch", "techcrunch.com"),
    anchor("API Docs", "docs.example.com"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: true,
  notes: "",
};

/** Two valid anchors — should block (pass:false, diagnosisAllowed:false). */
export const twoSourcesBlockRaw: SourceGateResult = {
  pass: false,
  minimumAnchorsFound: 2,
  needsExtraAnchor: false,
  sensitiveCategories: [],
  anchors: [
    anchor("Official Blog", "blog.example.com"),
    anchor("TechCrunch", "techcrunch.com"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: false,
  notes: "Only 2 anchors found; need at least 3.",
};

/** Three valid anchors but a sensitive category is present — should block. */
export const sensitiveThreeBlockRaw: SourceGateResult = {
  pass: false,
  minimumAnchorsFound: 3,
  needsExtraAnchor: true,
  sensitiveCategories: ["privacy"],
  anchors: [
    anchor("Official Blog", "blog.example.com"),
    anchor("TechCrunch", "techcrunch.com"),
    anchor("API Docs", "docs.example.com"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: false,
  notes: "Sensitive topic requires a 4th anchor.",
};

/** Four valid anchors with a sensitive category — should pass. */
export const sensitiveFourPassRaw: SourceGateResult = {
  pass: true,
  minimumAnchorsFound: 4,
  needsExtraAnchor: true,
  sensitiveCategories: ["privacy"],
  anchors: [
    anchor("Official Blog", "blog.example.com"),
    anchor("TechCrunch", "techcrunch.com"),
    anchor("API Docs", "docs.example.com"),
    anchor("FTC", "ftc.gov"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: true,
  notes: "",
};

/** Invalid JSON string for content-qa.sh failure tests. */
export const invalidJsonString = "{ this is not valid json,";

/**
 * Schema-valid JSON that is structurally fine but semantically blocks: pass is
 * false. Used to verify content-qa.sh stops on `pass:false`.
 */
export const passFalseBlocksRaw: SourceGateResult = twoSourcesBlockRaw;

/** Adversarial LLM output: only 2 anchors but self-reports pass:true. */
export const twoSourcesForgedPassRaw = {
  ...twoSourcesBlockRaw,
  pass: true,
  diagnosisAllowed: true,
  minimumAnchorsFound: 3,
};

/** Adversarial LLM output: sensitive topic has 3 anchors but self-reports pass:true. */
export const sensitiveThreeForgedPassRaw = {
  ...sensitiveThreeBlockRaw,
  pass: true,
  diagnosisAllowed: true,
  needsExtraAnchor: false,
};
