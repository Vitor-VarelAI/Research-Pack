import { z } from "zod";
import { CrawlOptionsSchema, type CrawlOptions, type CrawlProvider, type CrawlResult, type Provenance, type ScrapedDocument, type ScrapeOptions } from "../types.js";
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

/**
 * Firecrawl crawl status response.
 *
 * Pagination/cost fields are optional and only populated when the provider
 * exposes them:
 * - `next`: a relative or absolute URL to fetch the next page of results.
 *   Cross-origin `next` URLs are rejected before the bearer token is sent.
 * - `creditsUsed`: cumulative credits used by the job (provider-reported).
 * - `durationMs`: provider-reported job duration, when exposed.
 * - `startedAt` / `finishedAt` / `expiresAt`: provider-reported timestamps.
 */
const FirecrawlCrawlStatusResponseSchema = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
  creditsUsed: z.number().optional(),
  durationMs: z.number().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  next: z.string().optional(),
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
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const TRANSIENT_FIRECRAWL_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const CONFIG_INTEGER_PATTERN = /^\d+$/;

class FirecrawlHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Firecrawl ${status}: ${message}`);
    this.name = "FirecrawlHttpError";
    this.status = status;
  }
}

function resolveConfiguredInt(
  value: number | undefined,
  envName: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`${envName} must be an integer between ${bounds.min} and ${bounds.max}`);
    }
    return value;
  }

  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  if (!CONFIG_INTEGER_PATTERN.test(raw)) {
    throw new Error(`${envName} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${envName} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return parsed;
}

function resolveFirecrawlConfig(config?: Partial<FirecrawlConfig>): FirecrawlConfig {
  const apiKey = config?.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing FIRECRAWL_API_KEY. Create .env or export it before running.");
  }

  return {
    apiKey,
    baseUrl: config?.baseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2",
    pollIntervalMs: config?.pollIntervalMs ?? 2_000,
    pollTimeoutMs: config?.pollTimeoutMs ?? 120_000,
    requestTimeoutMs: resolveConfiguredInt(config?.requestTimeoutMs, "FIRECRAWL_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, {
      min: 1,
      max: 300_000,
    }),
    maxRetries: resolveConfiguredInt(config?.maxRetries, "FIRECRAWL_MAX_RETRIES", DEFAULT_MAX_RETRIES, { min: 0, max: 5 }),
    retryBaseDelayMs: resolveConfiguredInt(config?.retryBaseDelayMs, "FIRECRAWL_RETRY_BASE_DELAY_MS", DEFAULT_RETRY_BASE_DELAY_MS, {
      min: 0,
      max: 30_000,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * (2 ** attempt);
}

function parseResponseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    return String(body.error);
  }
  if (typeof body === "string" && body.length > 0) return body;
  return fallback;
}

async function fetchTextWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (timedOut) {
      throw new Error(`Firecrawl request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestFirecrawlJson(resolved: FirecrawlConfig, target: string, init: RequestInit): Promise<unknown> {
  const url = /^https?:\/\//i.test(target) ? target : `${resolved.baseUrl}${target}`;

  for (let attempt = 0; ; attempt += 1) {
    const { response, text } = await fetchTextWithTimeout(
      url,
      {
        ...init,
        headers: {
          "Authorization": `Bearer ${resolved.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      },
      resolved.requestTimeoutMs,
    );

    const body = parseResponseBody(text);
    if (response.ok) return body;

    const message = errorMessageFromBody(body, text);
    if (TRANSIENT_FIRECRAWL_STATUSES.has(response.status) && attempt < resolved.maxRetries) {
      await sleep(retryDelayMs(attempt, resolved.retryBaseDelayMs));
      continue;
    }

    throw new FirecrawlHttpError(response.status, message);
  }
}

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
    cacheState = normalizeCacheState(response.cacheState);
  } else if (typeof response.fromCache === "boolean") {
    cacheState = response.fromCache ? "cached" : "fresh";
    cacheStatus = `fromCache:${response.fromCache}`;
  } else if (typeof metadata.cacheState === "string" && metadata.cacheState.length > 0) {
    cacheStatus = metadata.cacheState;
    cacheState = normalizeCacheState(metadata.cacheState);
  }

  return {
    requestedAt,
    maxAgeMs: maxAgeMs ?? null,
    providerTimestamp,
    cacheState,
    cacheStatus,
  };
}

function normalizeCacheState(value: string): "fresh" | "cached" | "unknown" {
  const normalized = value.toLowerCase();
  if (normalized === "hit" || normalized === "cached") return "cached";
  if (normalized === "miss" || normalized === "fresh") return "fresh";
  return "unknown";
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
  const resolved = resolveFirecrawlConfig(config);

  /**
   * Issue an authenticated Firecrawl request. `target` may be either a path
   * (resolved against `baseUrl`) or a full absolute URL. Callers MUST ensure
   * any absolute URL passed here is same-origin with `baseUrl` before calling,
   * because the bearer token is attached unconditionally. Use
   * `resolveNextUrl` + `assertSameOrigin` for provider-supplied `next` URLs.
   */
  async function request(target: string, init: RequestInit): Promise<unknown> {
    return requestFirecrawlJson(resolved, target, init);
  }

  function normalizeMapLinks(links: FirecrawlMapLink[]): string[] {
    return links.map((link) => typeof link === "string" ? link : link.url);
  }

  /**
   * Poll `GET /crawl/{id}` until it reaches a terminal status or the deadline
   * expires. Returns the parsed terminal status response (which may carry a
   * `next` page URL and cost metadata).
   */
  async function pollCrawlStatus(id: string, deadline: number): Promise<z.infer<typeof FirecrawlCrawlStatusResponseSchema>> {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, resolved.pollIntervalMs));
      const statusBody = await request(`/crawl/${id}`, { method: "GET" });
      const status = FirecrawlCrawlStatusResponseSchema.parse(statusBody);
      if (status.success === false) throw new Error(status.error ?? "Firecrawl crawl failed");
      if (status.status === "completed") return status;
      if (status.status === "failed" || status.status === "cancelled") {
        throw new Error(`Firecrawl crawl ${status.status}`);
      }
    }
    throw new Error(`Firecrawl crawl timed out after ${resolved.pollTimeoutMs}ms`);
  }

  /**
   * Resolve a provider-supplied `next` value (relative or absolute URL)
   * against the Firecrawl base URL. Throws on unparseable input.
   */
  function resolveNextUrl(next: string, baseUrl: string): string {
    try {
      return new URL(next, baseUrl).toString();
    } catch {
      throw new Error(`Firecrawl crawl returned an invalid 'next' URL: ${next}`);
    }
  }

  /**
   * Reject cross-origin `next` URLs. The bearer token must never be sent to
   * another origin, so this is checked before any authenticated request to a
   * provider-supplied URL. Same-origin = same protocol + host + port.
   */
  function assertSameOrigin(targetUrl: string, baseUrl: string): void {
    let target: URL;
    let base: URL;
    try {
      target = new URL(targetUrl);
      base = new URL(baseUrl);
    } catch {
      throw new Error(`Firecrawl crawl 'next' is not a valid URL: ${targetUrl}`);
    }
    if (target.origin !== base.origin) {
      throw new Error(
        `Firecrawl crawl 'next' is cross-origin (${target.origin}); refusing to send bearer token to another origin (base ${base.origin})`,
      );
    }
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

    async crawl(url: string, options: CrawlOptions): Promise<CrawlResult> {
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
      let status = await pollCrawlStatus(start.id, deadline);

      // Aggregate documents and preserve pagination/cost metadata across all
      // `next` pages. Firecrawl reports `creditsUsed`/`durationMs`
      // cumulatively per status response, so the last non-null value seen is
      // preserved rather than summed across pages.
      const aggregated: FirecrawlPageData[] = [...(status.data ?? [])];
      let creditsUsed = status.creditsUsed ?? null;
      let durationMs = status.durationMs ?? null;
      let startedAt = status.startedAt ?? null;
      let finishedAt = status.finishedAt ?? null;
      let expiresAt = status.expiresAt ?? null;
      let pages = 1;

      // Safety cap: a malformed/lying provider could return `next` forever.
      // `limit` caps documents; this caps pagination pages to guarantee
      // termination even when a page returns zero documents with a `next`.
      const MAX_PAGES = 1000;

      let next = status.next;
      while (next) {
        if (pages >= MAX_PAGES) {
          throw new Error(`Firecrawl crawl exceeded ${MAX_PAGES} pagination pages without terminating`);
        }
        // Resolve relative `next` against the base URL, then reject any
        // cross-origin target BEFORE issuing an authenticated request, so the
        // bearer token is never sent to another origin.
        const nextUrl = resolveNextUrl(next, resolved.baseUrl);
        assertSameOrigin(nextUrl, resolved.baseUrl);
        const pageBody = await request(nextUrl, { method: "GET" });
        const page = FirecrawlCrawlStatusResponseSchema.parse(pageBody);
        if (page.success === false) throw new Error(page.error ?? "Firecrawl crawl pagination failed");
        aggregated.push(...(page.data ?? []));
        if (typeof page.creditsUsed === "number") creditsUsed = page.creditsUsed;
        if (typeof page.durationMs === "number") durationMs = page.durationMs;
        if (typeof page.startedAt === "string") startedAt = page.startedAt;
        if (typeof page.finishedAt === "string") finishedAt = page.finishedAt;
        if (typeof page.expiresAt === "string") expiresAt = page.expiresAt;
        next = page.next;
        pages += 1;
      }

      const documents = aggregated.map((item) => toDocument(url, item, buildProvenance(requestedAt, opts.maxAgeMs, { data: item })));
      return { documents, pages, creditsUsed, durationMs, startedAt, finishedAt, expiresAt };
    },
  };
}

export async function scrapeFirecrawlStructured(
  options: FirecrawlStructuredScrapeOptions,
  config?: Partial<FirecrawlConfig>,
): Promise<FirecrawlStructuredScrapeResult> {
  const resolved = resolveFirecrawlConfig(config);
  const requestedAt = nowIso();
  const maxAgeMs = options.maxAgeMs;
  const body = await requestFirecrawlJson(resolved, "/scrape", {
    method: "POST",
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

  const parsed = FirecrawlScrapeResponseSchema.parse(body);
  if (parsed.success === false || !parsed.data) throw new Error(parsed.error ?? "Firecrawl structured scrape failed");
  if (parsed.data.json === undefined) throw new Error("Firecrawl structured scrape returned no JSON data");

  const provenance = buildProvenance(requestedAt, maxAgeMs, parsed);
  const document = toDocument(options.url, parsed.data, provenance);
  return { document, data: parsed.data.json };
}

export async function runFirecrawlAgent(options: FirecrawlAgentOptions, config?: Partial<FirecrawlConfig>): Promise<FirecrawlAgentResult> {
  const resolved = resolveFirecrawlConfig(config);

  const requestedAt = nowIso();
  const maxAgeMs = options.maxAgeMs;
  const body = await requestFirecrawlJson(resolved, "/agent", {
    method: "POST",
    body: JSON.stringify({
      prompt: options.prompt,
      ...(options.urls ? { urls: options.urls } : {}),
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  });

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
    const statusBody = await requestFirecrawlJson(resolved, `/agent/${parsed.id}`, {
      method: "GET",
    });
    const status = FirecrawlAgentResponseSchema.parse(statusBody);
    if (status.success === false) throw new Error(status.error ?? "Firecrawl agent failed");
    if (status.data !== undefined) {
      return { data: status.data, provenance: { requestedAt, maxAgeMs: maxAgeMs ?? null } };
    }
    if (status.status === "failed" || status.status === "cancelled") throw new Error(`Firecrawl agent ${status.status}`);
  }

  throw new Error(`Firecrawl agent timed out waiting for job ${parsed.id}`);
}
