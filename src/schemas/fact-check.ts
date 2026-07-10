import { z } from "zod";

/**
 * DEPRECATED for single-page usage as of RP-01.
 *
 * `extract-ai --schema fact-check` now refuses to run and prints a migration
 * message. The canonical source sufficiency gate contract lives in
 * `src/schemas/source-gate.ts` (SourceGateResultSchema). This schema is kept
 * only for backwards-compatible JSON shape references and future `agent` /
 * `research` multi-page flows that may still emit this shape.
 *
 * Do not use this schema for new single-page fact-check extraction.
 */

export const FactCheckAnchorSchema = z.object({
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceType: z.enum(["official", "journalistic", "technical", "policy", "market", "other"]),
  confirmedClaims: z.array(z.string().min(1)).default([]),
  unconfirmedClaims: z.array(z.string().min(1)).default([]),
  interpretationRisk: z.string().min(1).default("No obvious interpretation risk."),
});

export const FactCheckExtractionSchema = z.object({
  topic: z.string().min(1),
  anchors: z.array(FactCheckAnchorSchema).min(3),
  sourceGaps: z.array(z.string().min(1)).default([]),
  safeToDiagnose: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

export type FactCheckExtraction = z.infer<typeof FactCheckExtractionSchema>;
