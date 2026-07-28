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

export const NON_SENSITIVE_MIN_ANCHORS = 3;
export const SENSITIVE_MIN_ANCHORS = 4;

/**
 * Return the anchors the gate can approve for downstream factual/editorial use.
 *
 * An anchor without a confirmed claim may remain in the gate artifact as
 * provenance, but it cannot support downstream facts or count toward the gate.
 */
export function selectApprovedSourceGateAnchors(
  anchors: readonly SourceGateAnchor[],
): SourceGateAnchor[] {
  return anchors.filter((anchor) => anchor.confirmedClaims.length > 0);
}

function deriveSourceGateState(
  anchors: readonly SourceGateAnchor[],
  sensitiveCategories: readonly SensitiveCategory[],
): {
  minimumAnchorsFound: number;
  needsExtraAnchor: boolean;
  pass: boolean;
} {
  const countedAnchors = selectApprovedSourceGateAnchors(anchors);
  const sourceTypes = new Set(countedAnchors.map((anchor) => anchor.sourceType));
  const needsExtraAnchor = sensitiveCategories.length > 0;
  const requiredAnchors = needsExtraAnchor ? SENSITIVE_MIN_ANCHORS : NON_SENSITIVE_MIN_ANCHORS;
  const hasRequiredDiversity =
    sourceTypes.has("official")
    && sourceTypes.has("journalistic")
    && (
      sourceTypes.has("technical")
      || sourceTypes.has("policy")
      || sourceTypes.has("market")
    );
  const minimumAnchorsFound = countedAnchors.length;

  return {
    minimumAnchorsFound,
    needsExtraAnchor,
    pass: minimumAnchorsFound >= requiredAnchors && hasRequiredDiversity,
  };
}

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
  const minimumAnchorsFound = selectApprovedSourceGateAnchors(result.anchors).length;
  const needsExtraAnchor = result.sensitiveCategories.length > 0;
  const requiredAnchors = needsExtraAnchor ? SENSITIVE_MIN_ANCHORS : NON_SENSITIVE_MIN_ANCHORS;

  if (result.minimumAnchorsFound !== minimumAnchorsFound) {
    ctx.addIssue({
      code: "custom",
      path: ["minimumAnchorsFound"],
      message: `minimumAnchorsFound must equal the number of anchors with confirmed claims (${minimumAnchorsFound})`,
    });
  }

  if (result.needsExtraAnchor !== needsExtraAnchor) {
    ctx.addIssue({
      code: "custom",
      path: ["needsExtraAnchor"],
      message: "needsExtraAnchor must be true exactly when sensitiveCategories is non-empty",
    });
  }

  if (result.pass && minimumAnchorsFound < requiredAnchors) {
    ctx.addIssue({
      code: "custom",
      path: ["pass"],
      message: `pass cannot be true with ${minimumAnchorsFound} counted anchors; required minimum is ${requiredAnchors}`,
    });
  }

  if (result.diagnosisAllowed !== result.pass) {
    ctx.addIssue({
      code: "custom",
      path: ["diagnosisAllowed"],
      message: "diagnosisAllowed must match pass",
    });
  }
});
export type SourceGateResult = z.infer<typeof SourceGateResultSchema>;

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
  const derived = deriveSourceGateState(input.anchors, sensitive);

  return SourceGateResultSchema.parse({
    pass: derived.pass,
    minimumAnchorsFound: derived.minimumAnchorsFound,
    needsExtraAnchor: derived.needsExtraAnchor,
    sensitiveCategories: sensitive,
    anchors: input.anchors,
    unsupportedClaims: input.unsupportedClaims ?? [],
    diagnosisAllowed: derived.pass,
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
