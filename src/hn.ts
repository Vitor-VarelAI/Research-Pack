import { z } from "zod";

const HnItemSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
  by: z.string().optional(),
  time: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  score: z.number().optional(),
  descendants: z.number().optional(),
  kids: z.array(z.number()).optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});
export type HnItem = z.infer<typeof HnItemSchema>;

export const HnStorySchema = z.object({
  id: z.number(),
  title: z.string(),
  url: z.string(),
  hnUrl: z.string(),
  score: z.number().nullable(),
  commentsCount: z.number().nullable(),
  rank: z.number(),
  aiSignals: z.array(z.string()),
});
export type HnStory = z.infer<typeof HnStorySchema>;

const HN_API_BASE = process.env.HN_API_BASE ?? "https://hacker-news.firebaseio.com/v0";

/**
 * Maximum number of concurrent HN item requests. The HN Firebase API is
 * fetched one item at a time per top-story id; without a cap, `--top 120`
 * would fire 120 simultaneous requests. The cap defaults to 8 and can be
 * overridden via the `HN_CONCURRENCY` env var (clamped to 1..50).
 */
const HN_CONCURRENCY_DEFAULT = 8;
const HN_CONCURRENCY_MAX = 50;

export function resolveHnConcurrency(): number {
  const env = process.env.HN_CONCURRENCY;
  if (env !== undefined && env !== "") {
    if (!/^\d+$/.test(env)) return HN_CONCURRENCY_DEFAULT;
    const n = Number.parseInt(env, 10);
    if (Number.isSafeInteger(n) && n >= 1 && n <= HN_CONCURRENCY_MAX) return n;
  }
  return HN_CONCURRENCY_DEFAULT;
}

const AI_SIGNAL_PATTERNS: Record<string, RegExp> = {
  ai: /\bAI\b|artificial intelligence/i,
  llm: /\bLLM\b|language model/i,
  openai: /\bOpenAI\b|\bChatGPT\b|\bGPT[-\s]?\d|\bGPT\b/i,
  anthropic: /\bAnthropic\b|\bClaude\b/i,
  mistral: /\bMistral\b|\bRobostral\b/i,
  google: /\bGemini\b|\bGoogle DeepMind\b/i,
  codingAgents: /\bagents?\b|\bcoding agent\b|\bSWE[-\s]?\d/i,
  robotics: /\brobot\b|\brobots\b|\brobotics\b|physical AI/i,
  benchmarks: /\bbenchmark\b|\bleaderboard\b|evals?/i,
};

export type HnAiContextOptions = {
  topStoriesLimit: number;
  aiStoriesLimit: number;
  neighborLimit: number;
  /** Optional HN request concurrency cap (defaults to resolveHnConcurrency()). */
  concurrency?: number;
};

export type HnAiContext = {
  generatedAt: string;
  aiStories: HnStory[];
  sameFrontpage: HnStory[];
  sameBoard: Array<{
    story: HnStory;
    board: string;
    why: string;
  }>;
};

export async function getHnTopStories(limit: number, concurrency: number = resolveHnConcurrency()): Promise<HnStory[]> {
  const ids = await getJson<number[]>(hnApiUrl("topstories.json"));
  const limitedIds = ids.slice(0, limit);
  const entries = await mapWithConcurrency(limitedIds, concurrency, async (id, index) => {
    const item = await getHnItem(id);
    return { item, rank: index + 1 };
  });
  return entries
    .filter(({ item }) => item.type === "story" && !item.deleted && !item.dead && item.title)
    .map(({ item, rank }) => toStory(item, rank));
}

export async function getHnAiContext(options: HnAiContextOptions): Promise<HnAiContext> {
  const stories = await getHnTopStories(options.topStoriesLimit, options.concurrency ?? resolveHnConcurrency());

  const aiStories = stories.filter((story) => story.aiSignals.length > 0).slice(0, options.aiStoriesLimit);
  const sameFrontpage = stories.slice(0, options.neighborLimit);
  const sameBoard = buildSameBoard(aiStories, sameFrontpage);

  return {
    generatedAt: new Date().toISOString(),
    aiStories,
    sameFrontpage,
    sameBoard,
  };
}

function toStory(item: HnItem, rank: number): HnStory {
  const title = item.title ?? `HN item ${item.id}`;
  const url = item.url ?? `https://news.ycombinator.com/item?id=${item.id}`;
  return HnStorySchema.parse({
    id: item.id,
    title,
    url,
    hnUrl: `https://news.ycombinator.com/item?id=${item.id}`,
    score: item.score ?? null,
    commentsCount: item.descendants ?? null,
    rank,
    aiSignals: detectAiSignals(`${title} ${url} ${item.text ?? ""}`),
  });
}

function detectAiSignals(value: string): string[] {
  return Object.entries(AI_SIGNAL_PATTERNS)
    .filter(([, pattern]) => pattern.test(value))
    .map(([signal]) => signal);
}

function buildSameBoard(aiStories: HnStory[], sameFrontpage: HnStory[]): HnAiContext["sameBoard"] {
  const boards: HnAiContext["sameBoard"] = [];
  for (const story of sameFrontpage) {
    const lower = story.title.toLowerCase();
    if (lower.includes("gpt") || lower.includes("openai") || lower.includes("chatgpt") || lower.includes("voice")) {
      boards.push({ story, board: "OpenAI / consumer distribution / interface", why: "OpenAI stories carry distribution, product interface, and access-control implications." });
    } else if (lower.includes("mistral") || lower.includes("robostral") || lower.includes("robot")) {
      boards.push({ story, board: "Europe AI sovereignty / physical AI", why: "Mistral stories carry the European champion question and the physical-AI front." });
    } else if (lower.includes("swe") || lower.includes("cognition") || lower.includes("cursor") || lower.includes("benchmark")) {
      boards.push({ story, board: "AI coding agents / benchmark credibility", why: "Coding-model stories often collide around benchmark trust, product lock-in, and developer workflow." });
    }
  }

  const aiIds = new Set(aiStories.map((story) => story.id));
  return boards.sort((a, b) => Number(aiIds.has(b.story.id)) - Number(aiIds.has(a.story.id)) || a.story.rank - b.story.rank);
}

async function getHnItem(id: number): Promise<HnItem> {
  return HnItemSchema.parse(await getJson<unknown>(hnApiUrl(`item/${id}.json`)));
}

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations, preserving
 * input order in the result array. The concurrency cap is the security/cost
 * control tested by RP-04: the maximum number of in-flight HN requests must
 * never exceed `limit`.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: safeLimit }, () => worker()));
  return results;
}

function hnApiUrl(path: string): string {
  return new URL(path, `${HN_API_BASE.replace(/\/$/, "")}/`).toString();
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HN request failed ${response.status}: ${url}`);
  return await response.json() as T;
}
