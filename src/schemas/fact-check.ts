import { z } from "zod";

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
