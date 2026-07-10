import { z } from "zod";
import { CrawlOptionsSchema, type CrawlOptions, type CrawlProvider, type Provenance, type ScrapedDocument, type ScrapeOptions } from "../types.js";
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

/**
 * Firecrawl scrape response. Cache provenance fields (`cacheState`, `fromCache`)
 * are optional and only populated when the provider reports them.
 */
const FirecrawlScrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  data: FirecrawlPageDataSchema.optional(),
  error: z.string().optional(),
  cacheState: z.string().optional(),
  fromCache: z.boolean().optional(),
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
  /** maxAge (ms) for the agent request. `0` forces fresh (research default). */
  maxAgeMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type FirecrawlAgentResult = {
  data: unknown;
  provenance: { requestedAt: string; maxAgeMs: number | null };
};

export type FirecrawlStructuredScrapeOptions = {
  url: string;
  prompt: string;
  schema: unknown;
  /** maxAge (ms). `0` forces fresh (research/fact-check default). */
  maxAgeMs?: number;
};

export type FirecrawlStructuredScrapeResult = {
  document: ScrapedDocument;
  data: unknown;
};

/**
 * Build provenance from the request side and the provider response.
 *
 * `maxAgeMs` is the value used in the request payload: `0` forces fresh,
 * `undefined`/`null` means maxAge was not sent.
 */
function buildProvenance(
  requestedAt: string,
  maxAgeMs: number | undefined,
  response: { cacheState?: string | undefined; fromCache?: boolean | undefined; data?: { metadata?: Record<string, unknown> | undefined } | undefined },
): Provenance {
  const metadata = response.data?.metadata ?? {};
  const providerTimestamp =
    typeof metadata.scrapedAt === "string" ? metadata.scrapedAt
    : typeof metadata.fetchedAt === "string" ? metadata.fetchedAt
    : null;

  let cacheState: "fresh" | "cached" | "unknown" = "unknown";
  let cacheStatus: string | null = null;

  if (typeof response.cacheState === "string" && response.cacheState.length > 0) {
    cacheStatus = response.cacheState;
    const normalized = response.cacheState.toLowerCase();
    cacheState = normalized === "hit" || normalized === "cached" ? "cached" : "fresh";
  } else if (typeof response.fromCache === "boolean") {
    cacheState = response.fromCache ? "cached" : "fresh";
    cacheStatus = `fromCache:${response.fromCache}`;
  } else if (typeof metadata.cacheState === "string" && metadata.cacheState.length > 0) {
    cacheStatus = metadata.cacheState;
    const normalized = metadata.cacheState.toLowerCase();
    cacheState = normalized === "hit" || normalized === "cached" ? "cached" : "fresh";
  }

  return {
    requestedAt,
    maxAgeMs: maxAgeMs ?? null,
    providerTimestamp,
    cacheState,
    cacheStatus,
  };
}

function toDocument(url: string, data: FirecrawlPageData, provenance: Provenance): ScrapedDocument {
  const metadata = data.metadata ?? {};
  const sourceUrl = typeof metadata.sourceURL === "string" ? metadata.sourceURL : url;
  const title = typeof metadata.title === "string" ? metadata.title : undefined;
  // Each collection of the same URL MUST create a new immutable snapshot id.
  // Do NOT seed makeId with the URL: that would overwrite previous snapshots.
  return {
    id: makeId("doc"),
    url: sourceUrl,
    ...(title ? { title } : {}),
    ...(data.markdown ? { markdown: data.markdown } : {}),
    ...(data.html ?? data.rawHtml ? { html: data.html ?? data.rawHtml } : {}),
    ...(data.screenshot ? { screenshot: data.screenshot } : {}),
    links: data.links ?? [],
    metadata,
    fetchedAt: provenance.requestedAt,
    provider: "firecrawl",
    provenance,
  };
}

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

  function normalizeMapLinks(links: FirecrawlMapLink[]): string[] {
    return links.map((link) => typeof link === "string" ? link : link.url);
  }

  return {
    async scrape(url: string, options?: ScrapeOptions): Promise<ScrapedDocument> {
      const requestedAt = nowIso();
      const maxAgeMs = options?.maxAgeMs;
      const body = await request("/scrape", {
        method: "POST",
        body: JSON.stringify({
          url,
          formats: ["markdown", "html", "links"],
          ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
        }),
      });
      const parsed = FirecrawlScrapeResponseSchema.parse(body);
      if (parsed.success === false || !parsed.data) throw new Error(parsed.error ?? "Firecrawl scrape failed");
      const provenance = buildProvenance(requestedAt, maxAgeMs, parsed);
      return toDocument(url, parsed.data, provenance);
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
      const requestedAt = nowIso();
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
            ...(opts.maxAgeMs !== undefined ? { maxAge: opts.maxAgeMs } : {}),
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
          return (status.data ?? []).map((item) => toDocument(url, item, buildProvenance(requestedAt, opts.maxAgeMs, { data: item })));
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
  const requestedAt = nowIso();
  const maxAgeMs = options.maxAgeMs;
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
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
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

  const provenance = buildProvenance(requestedAt, maxAgeMs, parsed);
  const document = toDocument(options.url, parsed.data, provenance);
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

  const requestedAt = nowIso();
  const maxAgeMs = options.maxAgeMs;
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
      ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
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
  if (parsed.data !== undefined) {
    return { data: parsed.data, provenance: { requestedAt, maxAgeMs: maxAgeMs ?? null } };
  }
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
    if (status.data !== undefined) {
      return { data: status.data, provenance: { requestedAt, maxAgeMs: maxAgeMs ?? null } };
    }
    if (status.status === "failed" || status.status === "cancelled") throw new Error(`Firecrawl agent ${status.status}`);
  }

  throw new Error(`Firecrawl agent timed out waiting for job ${parsed.id}`);
}
