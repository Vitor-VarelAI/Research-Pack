import { z } from "zod";
import type { HnStory } from "./hn.js";

export const RadarSignalSchema = z.enum([
  "ai-tool",
  "model-release",
  "web-design",
  "ui-experiment",
  "frontend-craft",
  "vfx-motion",
  "generative-video",
  "photography-imaging",
  "creative-coding",
  "webgl-threejs-shaders",
  "product-launch",
  "creator-workflow",
  "technical-drama",
  "pricing-licensing",
  "open-source",
  "benchmark",
  "failure-limitation",
  "visual-demo",
  "repo-code",
  "paper-research",
  "interactive-demo",
  "api-distribution",
  "platform-lock-in",
  "market-strategy",
  "infrastructure-geopolitics",
]);
export type RadarSignal = z.infer<typeof RadarSignalSchema>;

export const RadarScoresSchema = z.object({
  novelty: z.number().int().min(0).max(5),
  visualStrength: z.number().int().min(0).max(5),
  practicalUtility: z.number().int().min(0).max(5),
  domainFit: z.number().int().min(0).max(5),
  opinionPotential: z.number().int().min(0).max(5),
  verificationNeed: z.number().int().min(0).max(5),
  timingStrategy: z.number().int().min(0).max(5),
  distributionLeverage: z.number().int().min(0).max(5),
  moneyIncentive: z.number().int().min(0).max(5),
});
export type RadarScores = z.infer<typeof RadarScoresSchema>;

export const RadarItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  sourceUrl: z.string(),
  rank: z.number().int().positive().nullable(),
  score: z.number().nullable(),
  commentsCount: z.number().nullable(),
  signals: z.array(RadarSignalSchema),
  scores: RadarScoresSchema,
  totalScore: z.number(),
  whyCollect: z.string(),
  possibleAngles: z.array(z.string()),
  strategicQuestions: z.array(z.string()),
  rawSignals: z.array(z.string()),
});
export type RadarItem = z.infer<typeof RadarItemSchema>;

export const RadarReportSchema = z.object({
  generatedAt: z.string().datetime(),
  mode: z.literal("collect-wide"),
  criteria: z.array(z.string()),
  items: z.array(RadarItemSchema),
});
export type RadarReport = z.infer<typeof RadarReportSchema>;

const SIGNAL_RULES: Array<{ signal: RadarSignal; pattern: RegExp; reason: string }> = [
  { signal: "ai-tool", pattern: /\bAI\b|artificial intelligence|ChatGPT|Claude|Gemini|OpenAI|Anthropic|Mistral|LLM/i, reason: "AI/model/tool signal" },
  { signal: "model-release", pattern: /\bGPT[-\s]?\d|model|release|launch|preview|introduc/i, reason: "model or product release" },
  { signal: "web-design", pattern: /web design|landing page|website|portfolio|design system/i, reason: "web/design topic" },
  { signal: "ui-experiment", pattern: /UI|UX|interface|interaction|prototype/i, reason: "interface or interaction experiment" },
  { signal: "frontend-craft", pattern: /frontend|CSS|React|Next\.js|animation|component/i, reason: "frontend craft" },
  { signal: "vfx-motion", pattern: /VFX|motion design|animation|cinematic|After Effects|CapCut/i, reason: "motion/VFX topic" },
  { signal: "generative-video", pattern: /video generation|generative video|Kling|Veo|Sora|Runway|Seedance/i, reason: "generative video" },
  { signal: "photography-imaging", pattern: /camera|photo|photography|image|lighting|editing|lens/i, reason: "photo/image craft" },
  { signal: "creative-coding", pattern: /creative coding|p5\.js|Processing|shader|WebGL|Three\.js|canvas/i, reason: "creative coding" },
  { signal: "webgl-threejs-shaders", pattern: /WebGL|Three\.js|shader|GLSL|WebGPU/i, reason: "WebGL/shader signal" },
  { signal: "product-launch", pattern: /launch|introducing|released|now open source|show hn/i, reason: "launch or Show HN" },
  { signal: "creator-workflow", pattern: /workflow|creator|studio|designers|developers|artists|production/i, reason: "creator/dev workflow" },
  { signal: "technical-drama", pattern: /drama|controversy|backlash|leak|lawsuit|ban|blocked|security|vulnerability/i, reason: "technical controversy or risk" },
  { signal: "pricing-licensing", pattern: /pricing|license|licensing|subscription|paid|free|open source|closed/i, reason: "pricing/licensing angle" },
  { signal: "open-source", pattern: /open source|github\.com|GitHub|source available/i, reason: "open-source/repo" },
  { signal: "benchmark", pattern: /benchmark|leaderboard|eval|SWE|Terminal-Bench|score/i, reason: "benchmark/eval" },
  { signal: "failure-limitation", pattern: /fail|bug|limitation|broken|regression|worse|problem/i, reason: "failure/limitation" },
  { signal: "visual-demo", pattern: /demo|screenshot|gallery|visual|render|3D|image/i, reason: "visual/demo asset" },
  { signal: "repo-code", pattern: /github\.com|repo|repository|code/i, reason: "code repository" },
  { signal: "paper-research", pattern: /paper|arxiv|research|study|scientists/i, reason: "research/paper" },
  { signal: "interactive-demo", pattern: /interactive|playground|demo|live/i, reason: "interactive demo" },
  { signal: "api-distribution", pattern: /API|SDK|developer|app|plugin|browser|OS|cloud|marketplace|platform/i, reason: "distribution surface" },
  { signal: "platform-lock-in", pattern: /lock[-\s]?in|ecosystem|platform|closed|subscription|only available|exclusive/i, reason: "lock-in or ecosystem control" },
  { signal: "market-strategy", pattern: /earnings|stock|shares|rival|competitor|acquisition|layoff|hiring|regulation|antitrust|PR/i, reason: "market or strategic timing" },
  { signal: "infrastructure-geopolitics", pattern: /chip|GPU|Nvidia|cloud|compute|energy|copyright|China|Europe|EU|US|security|sovereign/i, reason: "infrastructure/geopolitics constraint" },
];

const RADAR_CRITERIA = [
  "AI tools e model releases",
  "web design, UI experiments, frontend craft",
  "VFX, motion design, generative video",
  "fotografia, imagem sintética, cameras, lighting, editing",
  "creative coding, WebGL, Three.js, shaders",
  "product launches com impacto visual/criativo",
  "workflows de creators, designers, devs e studios",
  "drama técnico útil: pricing, licensing, open source vs closed, benchmarks, failures",
  "exemplos visuais fortes, demos, before/after, breakdowns",
  "posts com screenshots, vídeos, repos, papers ou demos interativas",
  "timing estratégico: earnings, stocks, concorrência, regulação, eventos, hiring, layoffs ou hype cycles",
  "distribuição como vantagem: API, app, feed, OS, cloud, hardware, marketplace ou open weights",
  "dinheiro e incentivo: API, ads, subscription, compute, data, enterprise, marketplace, hardware, creator economy, lock-in",
  "contradições úteis: modelo poderoso sem API, grátis mas fechado na app, open com licença limitada, creator-first com ecossistema fechado",
];

export function buildRadarReportFromHn(stories: HnStory[], limit: number): RadarReport {
  const items = stories
    .map(scoreHnStory)
    .filter((item) => item.totalScore > 0)
    .sort((a, b) => b.totalScore - a.totalScore || (a.rank ?? 9999) - (b.rank ?? 9999))
    .slice(0, limit);

  return RadarReportSchema.parse({
    generatedAt: new Date().toISOString(),
    mode: "collect-wide",
    criteria: RADAR_CRITERIA,
    items,
  });
}

function scoreHnStory(story: HnStory): RadarItem {
  const haystack = `${story.title} ${story.url}`;
  const matched = SIGNAL_RULES.filter((rule) => rule.pattern.test(haystack));
  const signals = [...new Set(matched.map((rule) => rule.signal))];
  const rawSignals = matched.map((rule) => rule.reason);
  const scores = scoreSignals(story, signals);
  const totalScore = Object.entries(scores)
    .filter(([key]) => key !== "verificationNeed")
    .reduce((sum, [, value]) => sum + value, 0);

  return RadarItemSchema.parse({
    title: story.title,
    url: story.url,
    source: "hn",
    sourceUrl: story.hnUrl,
    rank: story.rank,
    score: story.score,
    commentsCount: story.commentsCount,
    signals,
    scores,
    totalScore,
    whyCollect: buildWhyCollect(signals, scores),
    possibleAngles: buildPossibleAngles(story, signals),
    strategicQuestions: buildStrategicQuestions(story, signals),
    rawSignals,
  });
}

function scoreSignals(story: HnStory, signals: RadarSignal[]): RadarScores {
  const has = (signal: RadarSignal): boolean => signals.includes(signal);
  const comments = story.commentsCount ?? 0;
  const score = story.score ?? 0;

  return {
    novelty: clampScore((has("model-release") || has("product-launch") ? 3 : 0) + (story.rank && story.rank <= 10 ? 1 : 0) + (score > 100 ? 1 : 0)),
    visualStrength: clampScore((has("visual-demo") ? 3 : 0) + (has("vfx-motion") || has("generative-video") || has("photography-imaging") ? 2 : 0) + (has("web-design") || has("ui-experiment") ? 1 : 0)),
    practicalUtility: clampScore((has("ai-tool") || has("frontend-craft") || has("repo-code") || has("creator-workflow") ? 2 : 0) + (has("open-source") ? 1 : 0) + (comments > 20 ? 1 : 0)),
    domainFit: clampScore(Math.min(signals.length, 5)),
    opinionPotential: clampScore((has("technical-drama") || has("pricing-licensing") || has("benchmark") || has("failure-limitation") ? 3 : 0) + (comments > 50 ? 1 : 0) + (has("open-source") ? 1 : 0)),
    verificationNeed: clampScore((has("benchmark") || has("technical-drama") ? 3 : 0) + (has("model-release") ? 1 : 0) + (story.url.includes("youtube.com") || story.url.includes("x.com") ? 1 : 0)),
    timingStrategy: clampScore((has("market-strategy") ? 3 : 0) + (has("model-release") || has("product-launch") ? 1 : 0) + (comments > 50 ? 1 : 0)),
    distributionLeverage: clampScore((has("api-distribution") ? 3 : 0) + (has("platform-lock-in") ? 2 : 0) + (has("open-source") ? 1 : 0)),
    moneyIncentive: clampScore((has("pricing-licensing") ? 3 : 0) + (has("platform-lock-in") ? 1 : 0) + (has("api-distribution") ? 1 : 0)),
  };
}

function buildWhyCollect(signals: RadarSignal[], scores: RadarScores): string {
  if (signals.length === 0) return "Low signal, collected only if adjacent context makes it useful.";
  const topSignals = signals.slice(0, 3).join(", ");
  return `Collect because it has ${topSignals}; domain fit ${scores.domainFit}/5, opinion potential ${scores.opinionPotential}/5, distribution leverage ${scores.distributionLeverage}/5.`;
}

function buildPossibleAngles(story: HnStory, signals: RadarSignal[]): string[] {
  const angles: string[] = [];
  if (signals.includes("model-release")) angles.push("What changes in the workflow if this release is real, not just benchmark theatre?");
  if (signals.includes("benchmark")) angles.push("Benchmark credibility: who benefits if this score becomes the story?");
  if (signals.includes("open-source")) angles.push("Open vs closed: what becomes possible when builders can inspect or self-host it?");
  if (signals.includes("visual-demo")) angles.push("Visual proof: is the demo showing a real workflow shift or just a good screenshot?");
  if (signals.includes("technical-drama")) angles.push("Drama as signal: what incentive or failure does the controversy reveal?");
  if (signals.includes("api-distribution")) angles.push("Distribution first: is the surface more important than the model itself?");
  if (signals.includes("platform-lock-in")) angles.push("Lock-in check: what behaviour is this trying to trap inside an ecosystem?");
  if (signals.includes("market-strategy")) angles.push("Timing check: why is this being announced now, and who needs this narrative?");
  if (angles.length === 0) angles.push(`Why this HN item at rank ${story.rank} might matter beyond the link.`);
  return angles.slice(0, 3);
}

function buildStrategicQuestions(story: HnStory, signals: RadarSignal[]): string[] {
  const questions = [
    "Why now: is this linked to a rival launch, regulation, earnings, hiring, layoffs, open source, or hype cycle?",
    "Who gains, who loses, and who gets cornered if this works?",
  ];

  if (signals.includes("api-distribution") || signals.includes("platform-lock-in")) {
    questions.push("Where does it live: API, app, feed, OS, cloud, hardware, marketplace, or open weights?");
  }

  if (signals.includes("pricing-licensing") || signals.includes("platform-lock-in")) {
    questions.push("Where is the money: API, ads, subscription, compute, data, marketplace, creator economy, or lock-in?");
  }

  if (signals.includes("open-source") || signals.includes("platform-lock-in")) {
    questions.push("Is this attack or defence: opening for adoption, or closing for control?");
  }

  if (signals.includes("infrastructure-geopolitics")) {
    questions.push("What infrastructure constraint matters here: chips, cloud, energy, regulation, copyright, security, China/US/Europe?");
  }

  if (signals.includes("creator-workflow") || signals.includes("visual-demo")) {
    questions.push("What changes for designers, devs, creators, photographers, VFX artists, or small teams?");
  }

  questions.push(`What is strange or contradictory about this item at HN rank ${story.rank}?`);
  questions.push("If this works, what happens in 6 months? If it fails, what does that reveal?");

  return questions.slice(0, 6);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(5, value));
}
