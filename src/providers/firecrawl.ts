import { z } from "zod";
import { CrawlOptionsSchema, type CrawlOptions, type CrawlProvider, type ScrapedDocument } from "../types.js";
import { makeId, nowIso } from "../util.js";

const FirecrawlPageDataSchema = z.object({
  markdown: z.string().optional(),
  html: z.string().optional(),
  json: z.unknown().optional(),
  rawHtml: z.string().optional(),
  screenshot: z.string().optional(),
  links: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
type FirecrawlPageData = z.infer<typeof FirecrawlPageDataSchema>;

const FirecrawlScrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  data: FirecrawlPageDataSchema.optional(),
  error: z.string().optional(),
});

const FirecrawlMapLinkSchema = z.union([
  z.string(),
  z.object({ url: z.string(), title: z.string().optional(), description: z.string().optional() }),
]);
type FirecrawlMapLink = z.infer<typeof FirecrawlMapLinkSchema>;

const FirecrawlMapResponseSchema = z.object({
  success: z.boolean().optional(),
  links: z.array(FirecrawlMapLinkSchema).optional(),
  data: z.union([z.array(FirecrawlMapLinkSchema), z.object({ links: z.array(FirecrawlMapLinkSchema).optional() })]).optional(),
  error: z.string().optional(),
});

const FirecrawlCrawlStartResponseSchema = z.object({
  success: z.boolean().optional(),
  id: z.string().optional(),
  error: z.string().optional(),
});

const FirecrawlCrawlStatusResponseSchema = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
  data: z.array(FirecrawlPageDataSchema).optional(),
  error: z.string().optional(),
});

const FirecrawlAgentResponseSchema = z.object({
  success: z.boolean().optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

type FirecrawlConfig = {
  apiKey: string;
  baseUrl: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
};

export type FirecrawlAgentOptions = {
  prompt: string;
  urls?: string[];
  schema?: unknown;
  model?: "spark-1-mini" | "spark-1-pro";
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type FirecrawlAgentResult = {
  data: unknown;
};

export type FirecrawlStructuredScrapeOptions = {
  url: string;
  prompt: string;
  schema: unknown;
};

export type FirecrawlStructuredScrapeResult = {
  document: ScrapedDocument;
  data: unknown;
};

export function createFirecrawlProvider(config?: Partial<FirecrawlConfig>): CrawlProvider {
  const apiKey = config?.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY. Create .env or export it before running.");
  }

  const resolved: FirecrawlConfig = {
    apiKey,
    baseUrl: config?.baseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2",
    pollIntervalMs: config?.pollIntervalMs ?? 2_000,
    pollTimeoutMs: config?.pollTimeoutMs ?? 120_000,
  };

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${resolved.baseUrl}${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${resolved.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : text;
      throw new Error(`Firecrawl ${response.status}: ${message}`);
    }
    return body;
  }

  function toDocument(url: string, data: FirecrawlPageData): ScrapedDocument {
    const metadata = data.metadata ?? {};
    const sourceUrl = typeof metadata.sourceURL === "string" ? metadata.sourceURL : url;
    const title = typeof metadata.title === "string" ? metadata.title : undefined;
    return {
      id: makeId("doc", sourceUrl),
      url: sourceUrl,
      ...(title ? { title } : {}),
      ...(data.markdown ? { markdown: data.markdown } : {}),
      ...(data.html ?? data.rawHtml ? { html: data.html ?? data.rawHtml } : {}),
      ...(data.screenshot ? { screenshot: data.screenshot } : {}),
      links: data.links ?? [],
      metadata,
      fetchedAt: nowIso(),
      provider: "firecrawl",
    };
  }

  function normalizeMapLinks(links: FirecrawlMapLink[]): string[] {
    return links.map((link) => typeof link === "string" ? link : link.url);
  }

  return {
    async scrape(url: string): Promise<ScrapedDocument> {
      const body = await request("/scrape", {
        method: "POST",
        body: JSON.stringify({
          url,
          formats: ["markdown", "html", "links"],
        }),
      });
      const parsed = FirecrawlScrapeResponseSchema.parse(body);
      if (parsed.success === false || !parsed.data) throw new Error(parsed.error ?? "Firecrawl scrape failed");
      return toDocument(url, parsed.data);
    },

    async map(url: string): Promise<string[]> {
      const body = await request("/map", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      const parsed = FirecrawlMapResponseSchema.parse(body);
      if (parsed.success === false) throw new Error(parsed.error ?? "Firecrawl map failed");
      if (Array.isArray(parsed.links)) return normalizeMapLinks(parsed.links);
      if (Array.isArray(parsed.data)) return normalizeMapLinks(parsed.data);
      return normalizeMapLinks(parsed.data?.links ?? []);
    },

    async crawl(url: string, options: CrawlOptions): Promise<ScrapedDocument[]> {
      const opts = CrawlOptionsSchema.parse(options);
      const startBody = await request("/crawl", {
        method: "POST",
        body: JSON.stringify({
          url,
          limit: opts.limit,
          ...(opts.includePaths ? { includePaths: opts.includePaths } : {}),
          ...(opts.excludePaths ? { excludePaths: opts.excludePaths } : {}),
          scrapeOptions: {
            formats: ["markdown", "html", "links"],
            ...(opts.waitForMs ? { waitFor: opts.waitForMs } : {}),
          },
        }),
      });
      const start = FirecrawlCrawlStartResponseSchema.parse(startBody);
      if (start.success === false || !start.id) throw new Error(start.error ?? "Firecrawl crawl did not return a job id");

      const deadline = Date.now() + resolved.pollTimeoutMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, resolved.pollIntervalMs));
        const statusBody = await request(`/crawl/${start.id}`, { method: "GET" });
        const status = FirecrawlCrawlStatusResponseSchema.parse(statusBody);
        if (status.success === false) throw new Error(status.error ?? "Firecrawl crawl failed");
        if (status.status === "completed") {
          return (status.data ?? []).map((item) => toDocument(url, item));
        }
        if (status.status === "failed" || status.status === "cancelled") {
          throw new Error(`Firecrawl crawl ${status.status}`);
        }
      }
      throw new Error(`Firecrawl crawl timed out after ${resolved.pollTimeoutMs}ms`);
    },
  };
}

export async function scrapeFirecrawlStructured(
  options: FirecrawlStructuredScrapeOptions,
  config?: Partial<FirecrawlConfig>,
): Promise<FirecrawlStructuredScrapeResult> {
  const apiKey = config?.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY. Create .env or export it before running.");
  }

  const baseUrl = config?.baseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2";
  const response = await fetch(`${baseUrl}/scrape`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: options.url,
      formats: [
        "markdown",
        "html",
        "links",
        { type: "json", schema: options.schema, prompt: options.prompt },
      ],
    }),
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : text;
    throw new Error(`Firecrawl ${response.status}: ${message}`);
  }

  const parsed = FirecrawlScrapeResponseSchema.parse(body);
  if (parsed.success === false || !parsed.data) throw new Error(parsed.error ?? "Firecrawl structured scrape failed");
  if (parsed.data.json === undefined) throw new Error("Firecrawl structured scrape returned no JSON data");

  const metadata = parsed.data.metadata ?? {};
  const sourceUrl = typeof metadata.sourceURL === "string" ? metadata.sourceURL : options.url;
  const title = typeof metadata.title === "string" ? metadata.title : undefined;
  const document: ScrapedDocument = {
    id: makeId("doc", sourceUrl),
    url: sourceUrl,
    ...(title ? { title } : {}),
    ...(parsed.data.markdown ? { markdown: parsed.data.markdown } : {}),
    ...(parsed.data.html ?? parsed.data.rawHtml ? { html: parsed.data.html ?? parsed.data.rawHtml } : {}),
    ...(parsed.data.screenshot ? { screenshot: parsed.data.screenshot } : {}),
    links: parsed.data.links ?? [],
    metadata,
    fetchedAt: nowIso(),
    provider: "firecrawl",
  };
  return { document, data: parsed.data.json };
}

export async function runFirecrawlAgent(options: FirecrawlAgentOptions, config?: Partial<FirecrawlConfig>): Promise<FirecrawlAgentResult> {
  const apiKey = config?.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY. Create .env or export it before running.");
  }

  const resolved: FirecrawlConfig = {
    apiKey,
    baseUrl: config?.baseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2",
    pollIntervalMs: config?.pollIntervalMs ?? 2_000,
    pollTimeoutMs: config?.pollTimeoutMs ?? 120_000,
  };

  const response = await fetch(`${resolved.baseUrl}/agent`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: options.prompt,
      ...(options.urls ? { urls: options.urls } : {}),
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  });

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body ? String(body.error) : text;
    throw new Error(`Firecrawl ${response.status}: ${message}`);
  }

  const parsed = FirecrawlAgentResponseSchema.parse(body);
  if (parsed.success === false) throw new Error(parsed.error ?? "Firecrawl agent failed");
  if (parsed.data !== undefined) return { data: parsed.data };
  if (!parsed.id) throw new Error(parsed.error ?? "Firecrawl agent did not return data or a job id");

  const deadline = Date.now() + (options.pollTimeoutMs ?? resolved.pollTimeoutMs);
  const pollIntervalMs = options.pollIntervalMs ?? resolved.pollIntervalMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const statusResponse = await fetch(`${resolved.baseUrl}/agent/${parsed.id}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${resolved.apiKey}` },
    });
    const statusText = await statusResponse.text();
    const statusBody: unknown = statusText ? JSON.parse(statusText) : {};
    if (!statusResponse.ok) {
      const message = typeof statusBody === "object" && statusBody !== null && "error" in statusBody ? String(statusBody.error) : statusText;
      throw new Error(`Firecrawl ${statusResponse.status}: ${message}`);
    }
    const status = FirecrawlAgentResponseSchema.parse(statusBody);
    if (status.success === false) throw new Error(status.error ?? "Firecrawl agent failed");
    if (status.data !== undefined) return { data: status.data };
    if (status.status === "failed" || status.status === "cancelled") throw new Error(`Firecrawl agent ${status.status}`);
  }

  throw new Error(`Firecrawl agent timed out waiting for job ${parsed.id}`);
}
