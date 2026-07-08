import { z } from "zod";

export const ArticleExtractionSchema = z.object({
  title: z.string().min(1),
  author: z.string().min(1).nullable().default(null),
  publishedAt: z.string().min(1).nullable().default(null),
  summary: z.string().min(1).nullable().default(null),
  body: z.string().min(1),
  sourceUrl: z.string().url(),
  evidence: z.array(z.object({
    field: z.string().min(1),
    quote: z.string().min(1),
  })).default([]),
});

export type ArticleExtraction = z.infer<typeof ArticleExtractionSchema>;
