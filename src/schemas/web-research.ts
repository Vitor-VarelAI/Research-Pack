import { z } from "zod";

export const WebResearchExtractionSchema = z.object({
  answer: z.string().min(1),
  facts: z.array(z.object({
    claim: z.string().min(1),
    evidence: z.string().min(1),
    sourceUrl: z.string().url().nullable().default(null),
  })).default([]),
  sources: z.array(z.string().url()).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

export type WebResearchExtraction = z.infer<typeof WebResearchExtractionSchema>;
