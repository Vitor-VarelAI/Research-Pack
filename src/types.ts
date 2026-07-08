import { z } from "zod";

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
});
export type ScrapedDocument = z.infer<typeof ScrapedDocumentSchema>;

export const CrawlOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).default(10),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional(),
  waitForMs: z.number().int().nonnegative().optional(),
});
export type CrawlOptions = z.infer<typeof CrawlOptionsSchema>;

export type CrawlProvider = {
  scrape(url: string): Promise<ScrapedDocument>;
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
