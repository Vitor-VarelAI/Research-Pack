import { isIP } from "node:net";
import { z } from "zod";
import { isReservedAddress } from "../security/public-host.js";

export const EDITORIAL_JOB_STATES = [
  "queued",
  "researching",
  "source_gate",
  "awaiting_angle",
  "diagnosing",
  "drafting",
  "formatting",
  "qa",
  "awaiting_final_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const EditorialJobStateSchema = z.enum(EDITORIAL_JOB_STATES);
export type EditorialJobState = z.infer<typeof EditorialJobStateSchema>;

export const EDITORIAL_JOB_STAGE_STATES = [
  "researching",
  "source_gate",
  "diagnosing",
  "drafting",
  "formatting",
  "qa",
] as const;
export type EditorialJobStage = (typeof EDITORIAL_JOB_STAGE_STATES)[number];

const credentialPattern = /["']?(?:api[_ -]?key|key|access[_ -]?token|refresh[_ -]?token|token|auth(?:orization)?|bearer|secret|password|passwd|cookie|session(?:id)?|private[_ -]?key)["']?\s*[:=]\s*["']?[^\s"',;}]+/iu;
const opaqueSecretPattern = /\b(?:(?:sk|fc|hf|ghp|xox[baprs])[-_][a-z0-9_-]{8,}|github_pat_[a-z0-9_]{12,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/iu;
const absolutePrivatePathPattern = /(?:^|[\s=(\[])\/(?:home|tmp|var|etc|opt|srv|root|private)(?:[\\/][^\s<>"']*)?/iu;

function containsCredentialLikeValue(value: string): boolean {
  return credentialPattern.test(value) || opaqueSecretPattern.test(value);
}

function isSensitiveQueryName(value: string): boolean {
  const compact = value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
  return compact === "key"
    || compact === "sig"
    || /(?:apikey|accesstoken|refreshtoken|oauthtoken|token|authorization|bearer|secret|password|passwd|cookie|sessionid|privatekey|signature)$/u.test(compact);
}

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host);
  return family === 4 || family === 6 ? isReservedAddress(host, family) : false;
}

export const EditorialUrlSchema = z.string().trim().url().superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "URL is invalid" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Only HTTP and HTTPS URLs are allowed" });
  }
  if (parsed.username || parsed.password) {
    context.addIssue({ code: "custom", message: "URL credentials are not allowed" });
  }
  for (const [name, queryValue] of parsed.searchParams) {
    if (isSensitiveQueryName(name) || containsCredentialLikeValue(`${name}=${queryValue}`) || containsCredentialLikeValue(queryValue)) context.addIssue({ code: "custom", message: "Credential-like URL query values are not allowed" });
  }
  if (isPrivateLiteral(parsed.hostname)) {
    context.addIssue({ code: "custom", message: "Private and localhost targets are not allowed" });
  }
});

const SafeContextSchema = z.string().trim().max(4_000).superRefine((value, context) => {
  if (containsCredentialLikeValue(value)) context.addIssue({ code: "custom", message: "Credential-like context is not allowed" });
  if (absolutePrivatePathPattern.test(value)) context.addIssue({ code: "custom", message: "Internal paths are not allowed in context" });
});
const SafeTopicSchema = z.string().trim().min(1).max(500).superRefine((value, context) => {
  if (containsCredentialLikeValue(value)) context.addIssue({ code: "custom", message: "Credential-like topic is not allowed" });
  if (absolutePrivatePathPattern.test(value)) context.addIssue({ code: "custom", message: "Internal paths are not allowed in topic" });
});

const TopicInputSchema = z.object({
  kind: z.literal("topic"),
  topic: SafeTopicSchema,
  context: SafeContextSchema.default(""),
  output: z.literal("blog-formats").default("blog-formats"),
  exportHtml: z.boolean().default(false),
}).strict();

const UrlInputSchema = z.object({
  kind: z.literal("url"),
  url: EditorialUrlSchema,
  context: SafeContextSchema.default(""),
  output: z.literal("blog-formats").default("blog-formats"),
  exportHtml: z.boolean().default(false),
}).strict();

export const EditorialJobInputSchema = z.discriminatedUnion("kind", [UrlInputSchema, TopicInputSchema]);
export type EditorialJobInput = z.infer<typeof EditorialJobInputSchema>;

export const EditorialArtifactRefSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(400)
    .refine((value) => !value.includes("\0"), "Artifact path contains a null byte")
    .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), "Artifact path must be relative")
    .refine((value) => !value.split(/[\\/]/u).some((segment) => segment === ".." || segment === "." || segment === ""), "Artifact path must not contain traversal segments"),
  createdAt: z.string().datetime(),
}).strict();
export type EditorialArtifactRef = z.infer<typeof EditorialArtifactRefSchema>;

export const EditorialStageSummarySchema = z.object({
  status: z.enum(["pending", "running", "completed", "blocked", "failed"]),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  warning: z.string().trim().max(500).nullable().default(null),
  artifacts: z.array(EditorialArtifactRefSchema).max(30).default([]),
}).strict();
export type EditorialStageSummary = z.infer<typeof EditorialStageSummarySchema>;

export const EditorialSafeErrorCodeSchema = z.enum([
  "source_gate_blocked",
  "human_rejected",
  "provider_timeout",
  "provider_cancelled",
  "provider_http",
  "provider_invalid_response",
  "generation_invalid",
  "storage_error",
  "cancelled",
  "interrupted",
  "unknown",
]);
export type EditorialSafeErrorCode = z.infer<typeof EditorialSafeErrorCodeSchema>;

export const EditorialJobErrorSchema = z.object({
  code: EditorialSafeErrorCodeSchema,
  stage: z.enum(["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa", "approval"]).nullable().default(null),
  message: z.string().trim().min(1).max(500),
}).strict();
export type EditorialJobError = z.infer<typeof EditorialJobErrorSchema>;

export const EditorialSelectedAngleSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  thesis: z.string().trim().min(1).max(2_000),
}).strict();

const stageSummaryShape = Object.fromEntries(EDITORIAL_JOB_STAGE_STATES.map((stage) => [stage, EditorialStageSummarySchema])) as Record<EditorialJobStage, typeof EditorialStageSummarySchema>;

export const EditorialJobSchema = z.object({
  id: z.string().regex(/^job_[a-f0-9-]{20,}$/u),
  revision: z.number().int().positive(),
  state: EditorialJobStateSchema,
  input: EditorialJobInputSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stageSummaries: z.object(stageSummaryShape).strict(),
  selectedAngle: EditorialSelectedAngleSchema.nullable().default(null),
  artifacts: z.array(EditorialArtifactRefSchema).max(100).default([]),
  error: EditorialJobErrorSchema.nullable().default(null),
  failedStage: z.enum(EDITORIAL_JOB_STAGE_STATES).nullable().default(null),
  rejectionNote: z.string().trim().max(1_000).nullable().default(null),
}).strict();
export type EditorialJob = z.infer<typeof EditorialJobSchema>;

export const EditorialJobEventSchema = z.object({
  sequence: z.number().int().positive(),
  at: z.string().datetime(),
  state: EditorialJobStateSchema,
  type: z.enum(["created", "transition", "artifact", "error", "cancelled", "recovered"]),
  message: z.string().trim().min(1).max(500),
}).strict();
export type EditorialJobEvent = z.infer<typeof EditorialJobEventSchema>;

export function sanitizeEditorialJobInput(input: EditorialJobInput): EditorialJobInput {
  const parsed = EditorialJobInputSchema.parse(input);
  return parsed.kind === "url"
    ? { ...parsed, context: redactSensitiveText(parsed.context) }
    : { ...parsed, topic: redactSensitiveText(parsed.topic), context: redactSensitiveText(parsed.context) };
}

export function redactSensitiveText(value: string, max = 4_000): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/["']?(?:api[_ -]?key|key|access[_ -]?token|refresh[_ -]?token|token|auth(?:orization)?|bearer|secret|password|passwd|cookie|session(?:id)?|private[_ -]?key)["']?\s*[:=]\s*["']?[^\s"',;}]+/giu, "[conteúdo omitido]")
    .replace(/\b(?:(?:sk|fc|hf|ghp|xox[baprs])[-_][a-z0-9_-]{8,}|github_pat_[a-z0-9_]{12,}|eyJ[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})\b/giu, "[conteúdo omitido]")
    .replace(/(?:^|[\s=(\[])\/(?:home|tmp|var|etc|opt|srv|root|private)(?:[\\/][^\s<>"']*)?/giu, "$1[caminho omitido]")
    .slice(0, max);
}

const transitions: Record<EditorialJobState, readonly EditorialJobState[]> = {
  queued: ["researching", "cancelled", "interrupted"],
  researching: ["source_gate", "failed", "cancelled", "interrupted"],
  source_gate: ["awaiting_angle", "failed", "cancelled", "interrupted"],
  awaiting_angle: ["diagnosing", "cancelled", "interrupted"],
  diagnosing: ["drafting", "failed", "cancelled", "interrupted"],
  drafting: ["formatting", "failed", "cancelled", "interrupted"],
  formatting: ["qa", "failed", "cancelled", "interrupted"],
  qa: ["awaiting_final_approval", "failed", "cancelled", "interrupted"],
  awaiting_final_approval: ["completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: ["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa", "cancelled"],
  cancelled: [],
  interrupted: ["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa", "cancelled"],
};

export function canEditorialJobTransition(from: EditorialJobState, to: EditorialJobState): boolean {
  return transitions[from].includes(to);
}

export function assertEditorialJobTransition(from: EditorialJobState, to: EditorialJobState): void {
  if (!canEditorialJobTransition(from, to)) throw new Error(`Invalid editorial job transition: ${from} -> ${to}`);
}

export const EDITORIAL_JOB_TRANSITIONS: Readonly<Record<EditorialJobState, readonly EditorialJobState[]>> = transitions;

export function createEmptyStageSummaries(): Record<EditorialJobStage, EditorialStageSummary> {
  return Object.fromEntries(EDITORIAL_JOB_STAGE_STATES.map((stage) => [stage, { status: "pending", startedAt: null, finishedAt: null, warning: null, artifacts: [] }])) as unknown as Record<EditorialJobStage, EditorialStageSummary>;
}

export function isExecutingEditorialJobState(state: EditorialJobState): boolean {
  return state === "queued" || (EDITORIAL_JOB_STAGE_STATES as readonly string[]).includes(state);
}

export function isHumanGateEditorialJobState(state: EditorialJobState): boolean {
  return state === "awaiting_angle" || state === "awaiting_final_approval";
}
