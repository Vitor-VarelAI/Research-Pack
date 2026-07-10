/**
 * Source sufficiency gate contract.
 *
 * This is a SOURCE SUFFICIENCY GATE, not a full factual-verification system.
 * It only checks whether enough valid source anchors exist before downstream
 * diagnosis/editorial linters may run. It does not verify whether individual
 * claims are true.
 *
 * Canonical output shape produced by `scripts/fact-check.sh` (see
 * `prompts/fact-check.md`) and validated by `scripts/content-qa.sh` before any
 * downstream linter runs.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Project-defined sensitive categories. When a topic touches any of these,
 * the gate requires at least 4 valid source anchors instead of 3.
 */
export const SENSITIVE_CATEGORIES = [
  "privacy",
  "copyright",
  "security",
  "financial claims",
  "benchmarks",
  "legal claims",
  "superlatives",
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const SensitiveCategorySchema = z.enum(SENSITIVE_CATEGORIES);

export const SourceGateAnchorSchema = z.object({
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceType: z.enum(["official", "journalistic", "technical", "policy", "market", "other"]),
  confirmedClaims: z.array(z.string().min(1)).default([]),
  unconfirmedClaims: z.array(z.string().min(1)).default([]),
  interpretationRisk: z.string().min(1).default("No obvious interpretation risk."),
});
export type SourceGateAnchor = z.infer<typeof SourceGateAnchorSchema>;

export const SourceGateUnsupportedClaimSchema = z.object({
  claim: z.string().min(1),
  whyUnsupported: z.string().min(1),
  suggestedSourceType: z.string().min(1),
});
export type SourceGateUnsupportedClaim = z.infer<typeof SourceGateUnsupportedClaimSchema>;

export const SourceGateResultSchema = z.object({
  pass: z.boolean(),
  minimumAnchorsFound: z.number().int().nonnegative(),
  needsExtraAnchor: z.boolean(),
  sensitiveCategories: z.array(SensitiveCategorySchema).default([]),
  anchors: z.array(SourceGateAnchorSchema),
  unsupportedClaims: z.array(SourceGateUnsupportedClaimSchema).default([]),
  diagnosisAllowed: z.boolean(),
  notes: z.string().default(""),
}).superRefine((result, ctx) => {
  const actualAnchorCount = result.anchors.length;
  const actualNeedsExtraAnchor = result.sensitiveCategories.length > 0;
  const requiredAnchors = actualNeedsExtraAnchor ? SENSITIVE_MIN_ANCHORS : NON_SENSITIVE_MIN_ANCHORS;
  const actualPass = actualAnchorCount >= requiredAnchors;

  if (result.minimumAnchorsFound !== actualAnchorCount) {
    ctx.addIssue({
      code: "custom",
      path: ["minimumAnchorsFound"],
      message: `minimumAnchorsFound must equal anchors.length (${actualAnchorCount})`,
    });
  }

  if (result.needsExtraAnchor !== actualNeedsExtraAnchor) {
    ctx.addIssue({
      code: "custom",
      path: ["needsExtraAnchor"],
      message: "needsExtraAnchor must be true exactly when sensitiveCategories is non-empty",
    });
  }

  if (result.pass !== actualPass) {
    ctx.addIssue({
      code: "custom",
      path: ["pass"],
      message: `pass must be ${actualPass} for ${actualAnchorCount} anchors and required minimum ${requiredAnchors}`,
    });
  }

  if (result.diagnosisAllowed !== actualPass) {
    ctx.addIssue({
      code: "custom",
      path: ["diagnosisAllowed"],
      message: "diagnosisAllowed must match the derived source sufficiency pass value",
    });
  }
});
export type SourceGateResult = z.infer<typeof SourceGateResultSchema>;

export const NON_SENSITIVE_MIN_ANCHORS = 3;
export const SENSITIVE_MIN_ANCHORS = 4;

/**
 * Evaluate source sufficiency from raw anchor data and detected sensitive
 * categories. Returns a fully-formed {@link SourceGateResult}.
 *
 * The result is always valid against {@link SourceGateResultSchema}: a result
 * with 0-2 anchors produces `pass:false` and `diagnosisAllowed:false` rather
 * than throwing.
 */
export function evaluateSourceGate(input: {
  anchors: SourceGateAnchor[];
  sensitiveCategories?: readonly SensitiveCategory[];
  unsupportedClaims?: SourceGateUnsupportedClaim[];
  notes?: string;
}): SourceGateResult {
  const sensitive = input.sensitiveCategories ?? [];
  const needsExtraAnchor = sensitive.length > 0;
  const required = needsExtraAnchor ? SENSITIVE_MIN_ANCHORS : NON_SENSITIVE_MIN_ANCHORS;
  const found = input.anchors.length;
  const passed = found >= required;

  return SourceGateResultSchema.parse({
    pass: passed,
    minimumAnchorsFound: found,
    needsExtraAnchor,
    sensitiveCategories: sensitive,
    anchors: input.anchors,
    unsupportedClaims: input.unsupportedClaims ?? [],
    diagnosisAllowed: passed,
    notes: input.notes ?? "",
  });
}

/**
 * Parse and validate a raw value (typically `JSON.parse` output) against the
 * source gate schema. Throws a ZodError on schema mismatch.
 */
export function parseSourceGateResult(value: unknown): SourceGateResult {
  return SourceGateResultSchema.parse(value);
}

/**
 * Read a source gate result JSON file, parse, and validate it.
 *
 * Steps:
 * 1. Read file contents (throws on missing/unreadable file).
 * 2. `JSON.parse` (throws `SyntaxError` on invalid JSON).
 * 3. Validate against {@link SourceGateResultSchema} (throws `ZodError`).
 *
 * On success, returns the parsed {@link SourceGateResult}.
 */
export function validateSourceGateFile(filePath: string): SourceGateResult {
  const text = readFileSync(filePath, "utf8");
  const json: unknown = JSON.parse(text);
  return parseSourceGateResult(json);
}
