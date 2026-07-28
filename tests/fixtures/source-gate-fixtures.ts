/**
 * Local fixtures for source gate tests. No network calls.
 *
 * These mirror the JSON shape documented in `prompts/fact-check.md` and
 * validated by `src/schemas/source-gate.ts`.
 */
import type { SourceGateResult } from "../../src/schemas/source-gate.js";

type FixtureSourceType = "official" | "journalistic" | "technical" | "policy" | "market" | "other";

const anchor = (
  sourceName: string,
  host: string,
  sourceType: FixtureSourceType,
  confirmedClaims: string[] = ["claim a"],
): {
  sourceName: string;
  sourceUrl: string;
  sourceType: FixtureSourceType;
  confirmedClaims: string[];
  unconfirmedClaims: string[];
  interpretationRisk: string;
} => ({
  sourceName,
  sourceUrl: `https://${host}/`,
  sourceType,
  confirmedClaims,
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
    anchor("Official Blog", "blog.example.com", "official"),
    anchor("TechCrunch", "techcrunch.com", "journalistic"),
    anchor("API Docs", "docs.example.com", "technical"),
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
    anchor("Official Blog", "blog.example.com", "official"),
    anchor("TechCrunch", "techcrunch.com", "journalistic"),
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
    anchor("Official Blog", "blog.example.com", "official"),
    anchor("TechCrunch", "techcrunch.com", "journalistic"),
    anchor("API Docs", "docs.example.com", "technical"),
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
    anchor("Official Blog", "blog.example.com", "official"),
    anchor("TechCrunch", "techcrunch.com", "journalistic"),
    anchor("API Docs", "docs.example.com", "technical"),
    anchor("FTC", "ftc.gov", "policy"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: true,
  notes: "",
};

/** Four counted anchors without an official source — should block. */
export const fourSourcesWithoutOfficialBlockRaw: SourceGateResult = {
  pass: false,
  minimumAnchorsFound: 4,
  needsExtraAnchor: false,
  sensitiveCategories: [],
  anchors: [
    anchor("Reuters", "reuters.com", "journalistic"),
    anchor("Financial Times", "ft.com", "journalistic"),
    anchor("Technical Analysis", "analysis.example.com", "technical"),
    anchor("Market Filing", "markets.example.com", "market"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: false,
  notes: "No official source anchor.",
};

/** Three anchors, but the only official source has no confirmed claims. */
export const unconfirmedOfficialBlockRaw: SourceGateResult = {
  pass: false,
  minimumAnchorsFound: 2,
  needsExtraAnchor: false,
  sensitiveCategories: [],
  anchors: [
    anchor("Official Blog", "blog.example.com", "official", []),
    anchor("Reuters", "reuters.com", "journalistic"),
    anchor("API Docs", "docs.example.com", "technical"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: false,
  notes: "The official anchor has no confirmed claims and is not counted.",
};

/** Four sensitive-topic anchors without a technical, policy, or market source. */
export const sensitiveFourMissingSupportingBucketBlockRaw: SourceGateResult = {
  pass: false,
  minimumAnchorsFound: 4,
  needsExtraAnchor: true,
  sensitiveCategories: ["privacy"],
  anchors: [
    anchor("Official Blog", "blog.example.com", "official"),
    anchor("Company Help Center", "help.example.com", "official"),
    anchor("Reuters", "reuters.com", "journalistic"),
    anchor("Financial Times", "ft.com", "journalistic"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: false,
  notes: "Sensitive topic lacks a technical, policy, or market anchor.",
};

/** Legacy gate that passed under the original count-only criteria. */
export const legacyNoDiversityPassRaw: SourceGateResult = {
  pass: true,
  minimumAnchorsFound: 3,
  needsExtraAnchor: false,
  sensitiveCategories: [],
  anchors: [
    anchor("Reuters", "reuters.com", "journalistic"),
    anchor("Financial Times", "ft.com", "journalistic"),
    anchor("The Verge", "theverge.com", "journalistic"),
  ],
  unsupportedClaims: [],
  diagnosisAllowed: true,
  notes: "Legacy count-only source gate.",
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
