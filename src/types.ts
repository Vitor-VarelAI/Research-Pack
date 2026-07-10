import { z } from "zod";

/**
 * Provenance for a collected document.
 *
 * Distinguishes:
 * - `requestedAt`: when *we* issued the scrape request (our clock).
 * - `providerTimestamp`: timestamp reported by the provider (Firecrawl
 *   metadata), if present; null when the provider did not report one.
 * - `cacheState` / `cacheStatus`: whether the provider served cached content.
 *
 * `fetchedAt` on the document is kept equal to `requestedAt` for backwards
 * compatibility, but cached content must NOT be reported as collected "now"
 * without these provenance fields showing what actually happened.
 *
 * `maxAgeMs` is the maxAge value used in the Firecrawl request payload:
 * - `0` means "force fresh, do not serve cache" (research/fact-check default).
 * - `null` means maxAge was not sent in the request.
 * - a positive number means "accept cache up to this age".
 */
export const ProvenanceSchema = z.object({
  requestedAt: z.string().datetime(),
  maxAgeMs: z.number().int().nonnegative().nullable().default(null),
  providerTimestamp: z.string().nullable().default(null),
  cacheState: z.enum(["fresh", "cached", "unknown"]).default("unknown"),
  cacheStatus: z.string().nullable().default(null),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ScrapedDocumentSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().optional(),
  markdown: z.string().optional(),
  html: z.string().optional(),
  links: z.array(z.string()).default([]),
  screenshot: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  fetchedAt: z.string().datetime(),
  provider: z.string().min(1),
  provenance: ProvenanceSchema,
});
export type ScrapedDocument = z.infer<typeof ScrapedDocumentSchema>;

export type ScrapeOptions = {
  /** maxAge (ms) to send in the Firecrawl scrape payload. `0` forces fresh. */
  maxAgeMs?: number;
};

export const CrawlOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).default(10),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  waitForMs: z.number().int().nonnegative().optional(),
  maxAgeMs: z.number().int().nonnegative().optional(),
});
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;

export type CrawlProvider = {
  scrape(url: string, options?: ScrapeOptions): Promise<ScrapedDocument>;
  crawl(url: string, options: CrawlOptions): Promise<ScrapedDocument[]>;
  map(url: string): Promise<string[]>;
};

export const RunRecordSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
