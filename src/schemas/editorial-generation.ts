import { z } from "zod";
import { EditorialUrlSchema } from "./editorial-job.js";
import { PublicationSlideSchema } from "./publication.js";
import { SourceGateResultSchema } from "./source-gate.js";

export const EditorialResearchAnchorSchema = z.object({
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl: EditorialUrlSchema,
  sourceType: z.enum(["official", "journalistic", "technical", "policy", "market", "other"]),
  title: z.string().trim().max(500).default(""),
  text: z.string().max(100_000).default(""),
  confirmedClaims: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  unconfirmedClaims: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  interpretationRisk: z.string().trim().min(1).max(1_000).default("No obvious interpretation risk."),
}).strict();
export type EditorialResearchAnchor = z.infer<typeof EditorialResearchAnchorSchema>;

export const EditorialResearchPackSchema = z.object({
  topic: z.string().trim().min(1).max(500),
  context: z.string().max(4_000).default(""),
  summary: z.string().trim().min(1).max(10_000),
  anchors: z.array(EditorialResearchAnchorSchema).max(50),
  sourceGate: SourceGateResultSchema,
}).strict();
export type EditorialResearchPack = z.infer<typeof EditorialResearchPackSchema>;

export const EditorialAngleCandidateSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1).max(300),
  thesis: z.string().trim().min(1).max(2_000),
  whyNow: z.string().trim().min(1).max(2_000),
  evidenceUrls: z.array(EditorialUrlSchema).min(1).max(20),
}).strict();
export type EditorialAngleCandidate = z.infer<typeof EditorialAngleCandidateSchema>;

export const EditorialAngleCandidatesSchema = z.object({
  candidates: z.array(EditorialAngleCandidateSchema).length(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.candidates.map((candidate) => candidate.id)).size !== value.candidates.length) {
    context.addIssue({ code: "custom", path: ["candidates"], message: "Angle candidate ids must be unique" });
  }
});
export type EditorialAngleCandidates = z.infer<typeof EditorialAngleCandidatesSchema>;

export function validateEditorialAngleCandidates(value: unknown, anchors: readonly EditorialResearchAnchor[]): EditorialAngleCandidates {
  const parsed = EditorialAngleCandidatesSchema.parse(value);
  const canonicalAnchors = new Set(anchors.map((anchor) => canonicalEditorialUrl(anchor.sourceUrl)));
  for (const candidate of parsed.candidates) {
    for (const url of candidate.evidenceUrls) {
      if (!canonicalAnchors.has(canonicalEditorialUrl(url))) {
        throw new Error(`Angle ${candidate.id} cites a URL that is not a canonical research anchor`);
      }
    }
  }
  return parsed;
}

export const EditorialLedgerEntrySchema = z.object({
  statement: z.string().trim().min(1).max(3_000),
  classification: z.enum(["FACTO", "INFERÊNCIA", "HIPÓTESE"]),
  sourceUrls: z.array(EditorialUrlSchema).max(20).default([]),
  rationale: z.string().trim().min(1).max(2_000),
}).strict().superRefine((entry, context) => {
  if (entry.classification === "FACTO" && entry.sourceUrls.length === 0) {
    context.addIssue({ code: "custom", path: ["sourceUrls"], message: "FACTO ledger entries require source URLs" });
  }
});
export type EditorialLedgerEntry = z.infer<typeof EditorialLedgerEntrySchema>;

export const EditorialDiagnosisSchema = z.object({
  centralInsight: z.string().trim().min(1).max(4_000),
  mechanism: z.string().trim().min(1).max(8_000),
  stakes: z.string().trim().min(1).max(8_000),
  implications: z.string().trim().min(1).max(8_000),
  recommendation: z.string().trim().min(1).max(8_000),
  ledger: z.array(EditorialLedgerEntrySchema).min(1).max(100),
}).strict();
export type EditorialDiagnosis = z.infer<typeof EditorialDiagnosisSchema>;

export const EditorialDraftClaimSchema = z.object({
  claim: z.string().trim().min(1).max(3_000),
  sourceUrls: z.array(EditorialUrlSchema).min(1).max(20),
}).strict();
export type EditorialDraftClaim = z.infer<typeof EditorialDraftClaimSchema>;

export const EditorialDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(1_000),
  bodyMarkdown: z.string().trim().min(1).max(200_000),
  claims: z.array(EditorialDraftClaimSchema).max(100),
}).strict();
export type EditorialDraft = z.infer<typeof EditorialDraftSchema>;

export const EditorialDerivativeSchema = z.string().trim().min(1).max(100_000);

export const EditorialFormatsSchema = z.object({
  newsletter: EditorialDerivativeSchema,
  linkedin: EditorialDerivativeSchema,
  xThread: EditorialDerivativeSchema,
  shortVideoIdeas: EditorialDerivativeSchema,
  carousel: EditorialDerivativeSchema,
  titlesHooks: EditorialDerivativeSchema,
  slides: z.array(PublicationSlideSchema).length(10),
}).strict();
export type EditorialFormats = z.infer<typeof EditorialFormatsSchema>;

const QaRiskSchema = z.string().trim().min(1).max(1_000);

export const EditorialLintQaSchema = z.object({
  pass: z.boolean(),
  model_verdict: z.enum(["PASS", "HOLD", "REVIEW"]),
  violations: z.array(QaRiskSchema).max(30).default([]),
  sourceRisks: z.array(QaRiskSchema).max(30).default([]),
  rhythmRisks: z.array(QaRiskSchema).max(30).default([]),
}).strict();
export type EditorialLintQa = z.infer<typeof EditorialLintQaSchema>;

export const FormatsLintQaSchema = z.object({
  pass: z.boolean(),
  model_verdict: z.enum(["PASS", "HOLD", "REVIEW"]),
  violations: z.array(QaRiskSchema).max(30).default([]),
  sourceRisks: z.array(QaRiskSchema).max(30).default([]),
  rhythmRisks: z.array(QaRiskSchema).max(30).default([]),
}).strict();
export type FormatsLintQa = z.infer<typeof FormatsLintQaSchema>;

export const EditorialQaSchema = z.object({
  passed: z.boolean(),
  warnings: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  checkedClaims: z.number().int().nonnegative(),
  sourceUrls: z.array(EditorialUrlSchema).max(100).default([]),
  editorialLint: EditorialLintQaSchema.optional(),
  formatsLint: FormatsLintQaSchema.optional(),
}).strict();
export type EditorialQa = z.infer<typeof EditorialQaSchema>;

export function canonicalEditorialUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}
