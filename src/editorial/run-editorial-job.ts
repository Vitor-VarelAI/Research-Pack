import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  runFirecrawlAgent,
  searchFirecrawl,
  createFirecrawlProvider,
  type FirecrawlAgentOptions,
  type FirecrawlAgentResult,
  type FirecrawlSearchOptions,
  type FirecrawlSearchResult,
} from "../providers/firecrawl.js";
import { WebResearchExtractionSchema } from "../schemas/web-research.js";
import type { CrawlProvider, ScrapedDocument } from "../types.js";
import { createDeepSeekClient, resolveDeepSeekConfig, type DeepSeekClient } from "../providers/deepseek.js";
import {
  EditorialJobInputSchema,
  type EditorialJob,
  type EditorialJobInput,
  redactSensitiveText,
  type EditorialJobStage,
  type EditorialSafeErrorCode,
  type EditorialStageSummary,
} from "../schemas/editorial-job.js";
import {
  canonicalEditorialUrl,
  EditorialAngleCandidatesSchema,
  EditorialDiagnosisSchema,
  EditorialDraftSchema,
  EditorialFormatsSchema,
  EditorialResearchPackSchema,
  EditorialQaSchema,
  EditorialLintQaSchema,
  FormatsLintQaSchema,
  validateEditorialAngleCandidates,
  type EditorialAngleCandidate,
  type EditorialAngleCandidates,
  type EditorialDiagnosis,
  type EditorialDraft,
  type EditorialFormats,
  type EditorialQa,
  type EditorialResearchAnchor,
  type EditorialResearchPack,
  type EditorialLintQa,
  type FormatsLintQa,
} from "../schemas/editorial-generation.js";
import { evaluateSourceGate, SENSITIVE_CATEGORIES, SourceGateResultSchema, type SensitiveCategory, type SourceGateAnchor } from "../schemas/source-gate.js";
import { createJobStore, type JobStore } from "../storage/job-store.js";
import { createPackageWriter, type PackageWriter } from "./package-writer.js";
import { assertPublicHttpUrl, systemPublicHostResolver, type PublicHostResolver } from "../security/public-host.js";
import { buildAnglesPrompt, buildDiagnosisPrompt, buildDraftPrompt, buildEditorialQaPrompt, buildFormatsPrompt, buildFormatsQaPrompt, buildResearchPrompt, delimit, EDITORIAL_SYSTEM_PROMPT } from "./prompts.js";

export type EditorialCollection = {
  anchors: EditorialResearchAnchor[];
  sourceText?: string;
};

export type EditorialCollector = {
  collect(input: EditorialJobInput, signal: AbortSignal): Promise<EditorialCollection>;
};

export type EditorialGeneration = {
  research(input: { job: EditorialJobInput; collection: EditorialCollection; signal: AbortSignal }): Promise<EditorialResearchPack>;
  angles(input: { job: EditorialJobInput; researchPack: EditorialResearchPack; signal: AbortSignal }): Promise<EditorialAngleCandidates>;
  diagnosis(input: { job: EditorialJobInput; researchPack: EditorialResearchPack; angle: EditorialAngleCandidate; signal: AbortSignal }): Promise<EditorialDiagnosis>;
  draft(input: { job: EditorialJobInput; researchPack: EditorialResearchPack; diagnosis: EditorialDiagnosis; signal: AbortSignal }): Promise<EditorialDraft>;
  formats(input: { job: EditorialJobInput; draft: EditorialDraft; diagnosis: EditorialDiagnosis; signal: AbortSignal }): Promise<EditorialFormats>;
  qa?(input: { job: EditorialJobInput; researchPack: EditorialResearchPack; draft: EditorialDraft; formats: EditorialFormats; signal: AbortSignal }): Promise<EditorialQa>;
};

export type EditorialRunnerOptions = {
  store: JobStore;
  collector: EditorialCollector;
  generation: EditorialGeneration;
  packageWriter: PackageWriter;
  logger?: Pick<Console, "error">;
};

export type EditorialRunner = {
  start(input: EditorialJobInput): Promise<EditorialJob>;
  /** Create and persist a queued job, then execute it without holding the caller. */
  startBackground(input: EditorialJobInput): Promise<EditorialJob>;
  selectAngle(jobId: string, angleId: string): Promise<EditorialJob>;
  approve(jobId: string): Promise<EditorialJob>;
  reject(jobId: string, note?: string): Promise<EditorialJob>;
  cancel(jobId: string): Promise<EditorialJob>;
  retry(jobId: string): Promise<EditorialJob>;
};

type Execution = { token: string; controller: AbortController };

export function createEditorialRunner(options: EditorialRunnerOptions): EditorialRunner {
  const logger = options.logger ?? console;
  const executions = new Map<string, Execution>();
  const cancellations = new Map<string, Promise<EditorialJob>>();
  const mutationTails = new Map<string, Promise<unknown>>();

  function withJobMutation<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationTails.get(jobId) ?? Promise.resolve();
    const next = previous.then(operation);
    const tail = next.then(() => undefined, () => undefined);
    mutationTails.set(jobId, tail);
    return next.finally(() => {
      if (mutationTails.get(jobId) === tail) mutationTails.delete(jobId);
    });
  }
  const cancelledSnapshots = new Map<string, EditorialJob>();

  async function start(input: EditorialJobInput): Promise<EditorialJob> {
    return executeStart(await options.store.create(EditorialJobInputSchema.parse(input)));
  }

  async function startBackground(input: EditorialJobInput): Promise<EditorialJob> {
    const job = await options.store.create(EditorialJobInputSchema.parse(input));
    // Keep the rejection contained: the runner normally persists failures, but
    // an unexpected storage error must never become an unhandled rejection.
    void executeStart(job).catch(() => undefined);
    return job;
  }

  async function executeStart(job: EditorialJob): Promise<EditorialJob> {
    const execution = beginExecution(job.id);
    try {
      let current = await options.store.transition(job.id, "researching", { stageSummaries: stageRunning(job.stageSummaries, "researching") }, { revision: job.revision, state: "queued" });
      current = await executeResearch(current, execution);
      return current;
    } catch (error) {
      const cancelled = cancelledSnapshots.get(job.id);
      if (execution.controller.signal.aborted && cancelled) return cancelled;
      const latest = await options.store.get(job.id);
      return failOrRethrow(job.id, execution, stageForState(latest.state) ?? "researching", error);
    } finally {
      finishExecution(job.id, execution);
    }
  }

  async function selectAngleUnlocked(jobId: string, angleId: string): Promise<EditorialJob> {
    const job = await options.store.get(jobId);
    if (job.state !== "awaiting_angle") throw new Error(`Angle selection requires awaiting_angle, received ${job.state}`);
    const angles = await readArtifact<EditorialAngleCandidates>(jobId, "angles.json", EditorialAngleCandidatesSchema.parse);
    const selected = angles.candidates.find((candidate) => candidate.id === angleId);
    if (!selected) throw new Error("Unknown editorial angle");
    const execution = beginExecution(jobId);
    try {
      const selectedAngle = { id: selected.id, title: selected.title, thesis: selected.thesis };
      let current = await options.store.transition(jobId, "diagnosing", {
        selectedAngle,
        stageSummaries: stageRunning(job.stageSummaries, "diagnosing"),
      }, { revision: job.revision, state: "awaiting_angle" });
      current = await executeDownstream(current, execution, selected);
      return current;
    } catch (error) {
      const cancelled = cancelledSnapshots.get(jobId);
      if (execution.controller.signal.aborted && cancelled) return cancelled;
      const latest = await options.store.get(jobId);
      return failOrRethrow(jobId, execution, stageForState(latest.state) ?? "diagnosing", error);
    } finally {
      finishExecution(jobId, execution);
    }
  }

  async function approveUnlocked(jobId: string, note?: string): Promise<EditorialJob> {
    const job = await options.store.get(jobId);
    if (job.state !== "awaiting_final_approval") throw new Error(`Approval requires awaiting_final_approval, received ${job.state}`);
    const researchPack = await readArtifact(jobId, "research-pack.json", EditorialResearchPackSchema.parse);
    const angles = await readArtifact(jobId, "angles.json", EditorialAngleCandidatesSchema.parse);
    const diagnosis = await readArtifact(jobId, "diagnosis.json", EditorialDiagnosisSchema.parse);
    const draft = await readArtifact(jobId, "draft.json", EditorialDraftSchema.parse);
    const formats = await readArtifact(jobId, "formats.json", EditorialFormatsSchema.parse);
    const qa = await readArtifact(jobId, "qa.json", EditorialQaSchema.parse);
    const persistedGate = await readArtifact(jobId, "source-gate.json", SourceGateResultSchema.parse);
    validateEditorialEvidence(researchPack, draft, diagnosis);
    assertCanonicalSourceGate(calculateCanonicalSourceGate(job.input, researchPack.anchors), researchPack.sourceGate);
    assertCanonicalSourceGate(researchPack.sourceGate, persistedGate);
    if (!researchPack.sourceGate.diagnosisAllowed) throw new Error("Editorial source gate no longer allows promotion");
    if (!isQaApproved(qa)) throw new Error("Editorial QA does not approve final promotion");
    const latest = await options.store.get(jobId);
    if (latest.state !== "awaiting_final_approval" || latest.revision !== job.revision) throw new Error("Editorial job changed before promotion");
    const finalPack = await readArtifact(jobId, "research-pack.json", EditorialResearchPackSchema.parse);
    const finalGate = await readArtifact(jobId, "source-gate.json", SourceGateResultSchema.parse);
    assertCanonicalSourceGate(calculateCanonicalSourceGate(latest.input, finalPack.anchors), finalPack.sourceGate);
    assertCanonicalSourceGate(finalPack.sourceGate, finalGate);
    if (!finalPack.sourceGate.diagnosisAllowed) throw new Error("Editorial source gate no longer allows promotion");
    const result = await options.packageWriter.write({ job: latest, researchPack: finalPack, angles, diagnosis, draft, formats, qa });
    const publicationRef = { kind: "publication", path: `editorial/${result.slug}/publication.json`, createdAt: new Date().toISOString() };
    try {
      return await options.store.transition(jobId, "completed", { artifacts: [...latest.artifacts, publicationRef] }, { revision: latest.revision, state: "awaiting_final_approval" });
    } catch (error) {
      await rm(result.packageDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function rejectUnlocked(jobId: string, note?: string): Promise<EditorialJob> {
    const job = await options.store.get(jobId);
    if (job.state !== "awaiting_final_approval") throw new Error(`Rejection requires awaiting_final_approval, received ${job.state}`);
    const rejectionNote = note?.trim().slice(0, 1_000) || null;
    return options.store.transition(jobId, "failed", {
      error: { code: "human_rejected", stage: "approval", message: "Final editorial approval was rejected" },
      failedStage: "drafting",
      rejectionNote,
    }, { revision: job.revision, state: "awaiting_final_approval" });
  }

  async function cancelUnlocked(jobId: string): Promise<EditorialJob> {
    const existing = cancellations.get(jobId);
    if (existing) return existing;
    const operation = cancelInternal(jobId);
    cancellations.set(jobId, operation);
    try {
      return await operation;
    } finally {
      if (cancellations.get(jobId) === operation) cancellations.delete(jobId);
    }
  }

  async function cancelInternal(jobId: string): Promise<EditorialJob> {
    const execution = executions.get(jobId);
    execution?.controller.abort();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await options.store.get(jobId);
      if (["completed", "failed", "cancelled"].includes(job.state)) {
        if (job.state === "cancelled") cancelledSnapshots.set(jobId, job);
        return job;
      }
      try {
        const cancelled = await options.store.transition(jobId, "cancelled", {
          error: { code: "cancelled", stage: stageForState(job.state), message: "Editorial job cancelled" },
        }, { revision: job.revision, state: job.state });
        cancelledSnapshots.set(jobId, cancelled);
        return cancelled;
      } catch (error) {
        const latest = await options.store.get(jobId);
        if (latest.state === "cancelled") return latest;
        if (latest.revision !== job.revision || latest.state !== job.state) continue;
        throw error;
      }
    }
    const latest = await options.store.get(jobId);
    if (latest.state === "cancelled" || ["completed", "failed"].includes(latest.state)) {
      if (latest.state === "cancelled") cancelledSnapshots.set(jobId, latest);
      return latest;
    }
    throw new Error("Editorial job changed while cancellation was being applied");
  }

  async function retryUnlocked(jobId: string): Promise<EditorialJob> {
    const job = await options.store.get(jobId);
    if (job.state !== "failed" && job.state !== "interrupted") throw new Error(`Retry requires failed or interrupted, received ${job.state}`);
    const target = retryStage(job);
    const execution = beginExecution(jobId);
    try {
      const current = await options.store.transition(jobId, target, {
        error: null,
        failedStage: null,
        stageSummaries: target === "source_gate" ? job.stageSummaries : stageRunning(job.stageSummaries, target),
      }, { revision: job.revision, state: job.state });
      if (target === "researching") return await executeResearch(current, execution);
      if (target === "source_gate") return await executeAngles(current, execution);
      if (target === "qa") return await executeQa(current, execution);
      const angles = await readArtifact(jobId, "angles.json", EditorialAngleCandidatesSchema.parse);
      const selected = current.selectedAngle;
      if (target === "diagnosing") {
        if (!selected) throw new Error("A selected angle is required before retrying diagnosis");
        const candidate = angles.candidates.find((angle) => angle.id === selected.id);
        if (!candidate) throw new Error("The selected angle artifact is unavailable");
        return await executeDownstream(current, execution, candidate, "diagnosing");
      }
      return await executeDownstream(current, execution, selected ? angles.candidates.find((angle) => angle.id === selected.id) : undefined, target);
    } catch (error) {
      const cancelled = cancelledSnapshots.get(jobId);
      if (execution.controller.signal.aborted && cancelled) return cancelled;
      return failOrRethrow(jobId, execution, target, error);
    } finally {
      finishExecution(jobId, execution);
    }
  }

  async function executeResearch(job: EditorialJob, execution: Execution): Promise<EditorialJob> {
    assertExecution(job, execution, "researching");
    const collection = await options.collector.collect(job.input, execution.controller.signal);
    assertExecution(await options.store.get(job.id), execution, "researching");
    const generated = await options.generation.research({ job: job.input, collection, signal: execution.controller.signal });
    const researchPack = buildDeterministicResearchPack(job.input, collection, generated);
    const researchRef = await writeJsonArtifact(job.id, "research-pack.json", researchPack, execution, "researching");
    let current = await completeStage(job.id, "researching", researchRef);
    current = await options.store.transition(job.id, "source_gate", { stageSummaries: stageRunning(current.stageSummaries, "source_gate") }, { revision: current.revision, state: "researching" });
    const gate = researchPack.sourceGate;
    const gateRef = await writeJsonArtifact(job.id, "source-gate.json", gate, execution, "source_gate");
    if (!gate.diagnosisAllowed) {
      const blockedSummary = { ...current.stageSummaries.source_gate, status: "blocked" as const, finishedAt: new Date().toISOString(), artifacts: [...current.stageSummaries.source_gate.artifacts, gateRef] };
      current = await options.store.update(current.id, { artifacts: [...current.artifacts, gateRef], stageSummaries: { ...current.stageSummaries, source_gate: blockedSummary } }, { revision: current.revision, state: "source_gate" });
      const error = { code: "source_gate_blocked" as const, stage: "source_gate" as const, message: "Source gate blocked diagnosis because the anchor threshold was not met" };
      return options.store.transition(current.id, "failed", { error, failedStage: "source_gate" }, { revision: current.revision, state: "source_gate" });
    }
    current = await completeStage(current.id, "source_gate", gateRef);
    return executeAngles(current, execution, researchPack);
  }

  async function executeAngles(job: EditorialJob, execution: Execution, persistedResearchPack?: EditorialResearchPack): Promise<EditorialJob> {
    assertExecution(job, execution, "source_gate");
    const researchPack = persistedResearchPack ?? await readArtifact(job.id, "research-pack.json", EditorialResearchPackSchema.parse);
    const persistedGate = await readArtifact(job.id, "source-gate.json", SourceGateResultSchema.parse);
    assertCanonicalSourceGate(calculateCanonicalSourceGate(job.input, researchPack.anchors), researchPack.sourceGate);
    assertCanonicalSourceGate(researchPack.sourceGate, persistedGate);
    if (!researchPack.sourceGate.diagnosisAllowed) throw new Error("Editorial source gate no longer allows angle generation");
    const anglesRaw = await options.generation.angles({ job: job.input, researchPack, signal: execution.controller.signal });
    const angles = validateEditorialAngleCandidates(anglesRaw, researchPack.anchors);
    const anglesRef = await writeJsonArtifact(job.id, "angles.json", angles, execution, "source_gate");
    const current = await addArtifact(job.id, anglesRef, "source_gate");
    return options.store.transition(current.id, "awaiting_angle", {}, { revision: current.revision, state: "source_gate" });
  }

  async function executeDownstream(job: EditorialJob, execution: Execution, selectedAngle?: EditorialAngleCandidate, from: EditorialJobStage = "diagnosing"): Promise<EditorialJob> {
    const researchPack = await readArtifact(job.id, "research-pack.json", EditorialResearchPackSchema.parse);
    const angle = selectedAngle ?? (await readArtifact<EditorialAngleCandidates>(job.id, "angles.json", EditorialAngleCandidatesSchema.parse)).candidates.find((item) => item.id === job.selectedAngle?.id);
    if (!angle) throw new Error("A selected angle is required");
    let current = job;
    if (from === "diagnosing") {
      assertExecution(current, execution, "diagnosing");
      const diagnosis = EditorialDiagnosisSchema.parse(await options.generation.diagnosis({ job: job.input, researchPack, angle, signal: execution.controller.signal }));
      validateEditorialEvidence(researchPack, undefined, diagnosis);
      const diagnosisRef = await writeJsonArtifact(job.id, "diagnosis.json", diagnosis, execution, "diagnosing");
      current = await completeStage(job.id, "diagnosing", diagnosisRef);
      current = await options.store.transition(job.id, "drafting", { stageSummaries: stageRunning(current.stageSummaries, "drafting") }, { revision: current.revision, state: "diagnosing" });
    }
    const diagnosis = await readArtifact(job.id, "diagnosis.json", EditorialDiagnosisSchema.parse);
    if (from === "diagnosing" || from === "drafting") {
      if (current.state === "drafting") assertExecution(current, execution, "drafting");
      const draft = EditorialDraftSchema.parse(await options.generation.draft({ job: job.input, researchPack, diagnosis, signal: execution.controller.signal }));
      validateEditorialEvidence(researchPack, draft, diagnosis);
      const draftRef = await writeJsonArtifact(job.id, "draft.json", draft, execution, "drafting");
      current = await completeStage(job.id, "drafting", draftRef);
      current = await options.store.transition(job.id, "formatting", { stageSummaries: stageRunning(current.stageSummaries, "formatting") }, { revision: current.revision, state: "drafting" });
    }
    const draft = await readArtifact(job.id, "draft.json", EditorialDraftSchema.parse);
    if (["diagnosing", "drafting", "formatting"].includes(from)) {
      if (current.state === "formatting") assertExecution(current, execution, "formatting");
      const formats = EditorialFormatsSchema.parse(await options.generation.formats({ job: job.input, draft, diagnosis, signal: execution.controller.signal }));
      const formatsRef = await writeJsonArtifact(job.id, "formats.json", formats, execution, "formatting");
      current = await completeStage(job.id, "formatting", formatsRef);
      current = await options.store.transition(job.id, "qa", { stageSummaries: stageRunning(current.stageSummaries, "qa") }, { revision: current.revision, state: "formatting" });
    }
    return executeQa(current, execution);
  }

  async function executeQa(job: EditorialJob, execution: Execution): Promise<EditorialJob> {
    assertExecution(job, execution, "qa");
    const researchPack = await readArtifact(job.id, "research-pack.json", EditorialResearchPackSchema.parse);
    const diagnosis = await readArtifact(job.id, "diagnosis.json", EditorialDiagnosisSchema.parse);
    const draft = await readArtifact(job.id, "draft.json", EditorialDraftSchema.parse);
    const formats = await readArtifact(job.id, "formats.json", EditorialFormatsSchema.parse);
    validateEditorialEvidence(researchPack, draft, diagnosis);
    const qa = EditorialQaSchema.parse(options.generation.qa
      ? await options.generation.qa({ job: job.input, researchPack, draft, formats, signal: execution.controller.signal })
      : evaluateEditorialQa(researchPack, draft, formats));
    const qaRef = await writeJsonArtifact(job.id, "qa.json", qa, execution, "qa");
    const current = await completeStage(job.id, "qa", qaRef);
    if (!isQaApproved(qa)) return options.store.transition(current.id, "failed", { error: { code: "generation_invalid", stage: "qa", message: "Editorial QA blocked final approval" }, failedStage: "qa" }, { revision: current.revision, state: "qa" });
    return options.store.transition(current.id, "awaiting_final_approval", {}, { revision: current.revision, state: "qa" });
  }

  async function completeStage(jobId: string, stage: EditorialJobStage, ref: { kind: string; path: string; createdAt: string }): Promise<EditorialJob> {
    const current = await options.store.get(jobId);
    if (current.state !== stage) throw new Error(`Late ${stage} completion was ignored`);
    const summary = { ...current.stageSummaries[stage], status: "completed" as const, finishedAt: new Date().toISOString(), artifacts: [...current.stageSummaries[stage].artifacts, ref] };
    const stageSummaries = { ...current.stageSummaries, [stage]: summary };
    return options.store.update(jobId, { artifacts: [...current.artifacts, ref], stageSummaries }, { revision: current.revision, state: stage });
  }

  async function addArtifact(jobId: string, ref: { kind: string; path: string; createdAt: string }, stage: EditorialJobStage): Promise<EditorialJob> {
    const current = await options.store.get(jobId);
    if (current.state !== stage) throw new Error(`Late ${stage} completion was ignored`);
    const summary = { ...current.stageSummaries[stage], artifacts: [...current.stageSummaries[stage].artifacts, ref] };
    return options.store.update(jobId, { artifacts: [...current.artifacts, ref], stageSummaries: { ...current.stageSummaries, [stage]: summary } }, { revision: current.revision, state: stage });
  }

  async function writeJsonArtifact<T>(jobId: string, name: string, value: T, execution: Execution, stage: EditorialJobStage): Promise<{ kind: string; path: string; createdAt: string }> {
    assertExecution(await options.store.get(jobId), execution, stage);
    return options.store.writeArtifact(jobId, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function readArtifact<T>(jobId: string, name: string, parse: (value: unknown) => T): Promise<T> {
    const storeWithRead = options.store as JobStore & { readArtifact?: (id: string, relativePath: string) => Promise<string> };
    if (!storeWithRead.readArtifact) throw new Error("Job store does not support artifact reads");
    return parse(JSON.parse(await storeWithRead.readArtifact(jobId, name)) as unknown);
  }

  async function failOrRethrow(jobId: string, execution: Execution, stage: EditorialJobStage, error: unknown): Promise<EditorialJob> {
    const cancelled = cancelledSnapshots.get(jobId);
    if (execution.controller.signal.aborted && cancelled) return cancelled;
    const current = await options.store.get(jobId);
    if (current.state === "cancelled") return current;
    if (error instanceof Error && error.message.includes("Late")) {
      const cancellation = cancellations.get(jobId);
      if (cancellation) {
        await cancellation;
        return options.store.get(jobId);
      }
      if (execution.controller.signal.aborted) {
        await new Promise((resolve) => setImmediate(resolve));
        const latest = await options.store.get(jobId);
        if (latest.state === "cancelled") return latest;
      }
      throw error;
    }
    const safe = toSafeError(error, stage);
    const diagnostic = formatEditorialRunnerFailure(jobId, stage, safe.code, error);
    logger.error(diagnostic);
    await options.store.appendEvent(jobId, { state: current.state, type: "error", message: diagnostic }).catch(() => undefined);
    if (current.state === stage) return options.store.transition(jobId, "failed", { error: safe, failedStage: stage }, { revision: current.revision, state: stage });
    throw error;
  }

  function beginExecution(jobId: string): Execution {
    const previous = executions.get(jobId);
    previous?.controller.abort();
    const execution = { token: `${Date.now()}-${Math.random()}`, controller: new AbortController() };
    executions.set(jobId, execution);
    return execution;
  }

  function finishExecution(jobId: string, execution: Execution): void {
    if (executions.get(jobId) === execution) {
      executions.delete(jobId);
      cancelledSnapshots.delete(jobId);
    }
  }

  function assertExecution(job: EditorialJob, execution: Execution, stage: EditorialJobStage): void {
    if (executions.get(job.id) !== execution || execution.controller.signal.aborted || job.state !== stage) throw new Error(`Late ${stage} completion was ignored`);
  }

  const selectAngle = (jobId: string, angleId: string): Promise<EditorialJob> => withJobMutation(jobId, () => selectAngleUnlocked(jobId, angleId));
  const approve = (jobId: string): Promise<EditorialJob> => withJobMutation(jobId, () => approveUnlocked(jobId));
  const reject = (jobId: string, note?: string): Promise<EditorialJob> => withJobMutation(jobId, () => rejectUnlocked(jobId, note));
  const cancel = (jobId: string): Promise<EditorialJob> => withJobMutation(jobId, () => cancelUnlocked(jobId));
  const retry = (jobId: string): Promise<EditorialJob> => withJobMutation(jobId, () => retryUnlocked(jobId));

  return { start, startBackground, selectAngle, approve, reject, cancel, retry };
}

export async function runEditorialJob(input: EditorialJobInput, callbacks: EditorialRunnerOptions): Promise<EditorialJob> {
  return createEditorialRunner(callbacks).start(input);
}

const PRODUCTION_PROVIDER_VARIABLES = ["FIRECRAWL_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"] as const;
export type ProductionProviderVariable = typeof PRODUCTION_PROVIDER_VARIABLES[number] | "FIRECRAWL_BASE_URL";
export type ProductionEditorialRunnerReadiness = {
  ready: boolean;
  unavailableVariables: ProductionProviderVariable[];
};

/** Validate local production configuration without constructing clients or contacting providers. */
export function inspectProductionEditorialRunnerReadiness(environment: NodeJS.ProcessEnv = process.env): ProductionEditorialRunnerReadiness {
  const unavailable = new Set<ProductionProviderVariable>();
  if (!environment.FIRECRAWL_API_KEY?.trim()) unavailable.add("FIRECRAWL_API_KEY");
  const firecrawlBaseUrl = environment.FIRECRAWL_BASE_URL?.trim();
  if (firecrawlBaseUrl && !isHttpProviderUrl(firecrawlBaseUrl)) unavailable.add("FIRECRAWL_BASE_URL");
  if (!environment.DEEPSEEK_API_KEY?.trim()) unavailable.add("DEEPSEEK_API_KEY");
  if (!isHttpProviderUrl(environment.DEEPSEEK_BASE_URL)) unavailable.add("DEEPSEEK_BASE_URL");
  if (!environment.DEEPSEEK_MODEL?.trim()) unavailable.add("DEEPSEEK_MODEL");
  const unavailableVariables: ProductionProviderVariable[] = PRODUCTION_PROVIDER_VARIABLES.filter((name) => unavailable.has(name));
  if (unavailable.has("FIRECRAWL_BASE_URL")) unavailableVariables.push("FIRECRAWL_BASE_URL");
  return { ready: unavailableVariables.length === 0, unavailableVariables };
}

export function createProductionEditorialRunner(
  dataRoot = process.env.SCRAPE_AGENT_DATA_DIR ?? "data",
  environment: NodeJS.ProcessEnv = process.env,
  logger: Pick<Console, "error"> = console,
): EditorialRunner {
  let resolved: EditorialRunner | undefined;
  const getRunner = (): EditorialRunner => {
    if (!resolved) {
      // Configuration is resolved on the first action, while cockpit readiness
      // uses the matching local-only inspection above.
      const readiness = inspectProductionEditorialRunnerReadiness(environment);
      if (!readiness.ready) throw new Error(`Missing or invalid provider configuration: ${readiness.unavailableVariables.join(", ")}`);
      const firecrawlApiKey = environment.FIRECRAWL_API_KEY?.trim();
      if (!firecrawlApiKey) throw new Error("Missing FIRECRAWL_API_KEY");
      const deepseek = createDeepSeekClient(resolveDeepSeekConfig(environment));
      const firecrawlBaseUrl = environment.FIRECRAWL_BASE_URL?.trim();
      const firecrawlConfig = {
        apiKey: firecrawlApiKey,
        ...(firecrawlBaseUrl ? { baseUrl: firecrawlBaseUrl } : {}),
      };
      const firecrawl = createFirecrawlProvider(firecrawlConfig);
      resolved = createEditorialRunner({
        store: createJobStore(dataRoot),
        collector: createProductionFirecrawlCollector(
          firecrawl,
          (options) => runFirecrawlAgent(options, firecrawlConfig),
          (options) => searchFirecrawl(options, firecrawlConfig),
        ),
        generation: createDeepSeekGeneration(deepseek),
        packageWriter: createPackageWriter(dataRoot),
        logger,
      });
    }
    return resolved;
  };
  return {
    start: (input) => getRunner().start(input),
    startBackground: (input) => getRunner().startBackground(input),
    selectAngle: (jobId, angleId) => getRunner().selectAngle(jobId, angleId),
    approve: (jobId) => getRunner().approve(jobId),
    reject: (jobId, note) => getRunner().reject(jobId, note),
    cancel: (jobId) => getRunner().cancel(jobId),
    retry: (jobId) => getRunner().retry(jobId),
  };
}

function isHttpProviderUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export type FirecrawlDiscovery = (options: FirecrawlAgentOptions) => Promise<FirecrawlAgentResult>;
export type FirecrawlSearch = (options: FirecrawlSearchOptions) => Promise<FirecrawlSearchResult>;

export const MAX_PRODUCTION_DISCOVERY_SOURCES = 6;
export const MAX_PRODUCTION_SEARCH_RESULTS = MAX_PRODUCTION_DISCOVERY_SOURCES - 1;
export const MAX_PRODUCTION_SOURCE_TEXT_BYTES = 400_000;
export const MAX_PRODUCTION_ANCHOR_TEXT_BYTES = 100_000;

const ProductionDiscoverySchema = WebResearchExtractionSchema.extend({
  sources: z.array(z.string().url()).max(MAX_PRODUCTION_DISCOVERY_SOURCES).default([]),
}).strict();

const ProductionDiscoveryJsonSchema = stripJsonSchemaMeta(z.toJSONSchema(ProductionDiscoverySchema));
const PRODUCTION_DISCOVERY_PROMPT = "Find three to six useful independent web sources for the supplied topic. Return only the existing web-research JSON contract. Return HTTP(S) URLs only, never credentials or private targets, and do not invent URLs.";

export function createProductionFirecrawlCollector(
  provider: CrawlProvider,
  discover: FirecrawlDiscovery = runFirecrawlAgent,
  search: FirecrawlSearch = searchFirecrawl,
  resolveHost?: PublicHostResolver,
): EditorialCollector {
  return createFirecrawlCollector(provider, discover, search, resolveHost ?? systemPublicHostResolver);
}

export function createFirecrawlCollector(
  provider: CrawlProvider,
  discover: FirecrawlDiscovery = runFirecrawlAgent,
  search: FirecrawlSearch = searchFirecrawl,
  resolveHost?: PublicHostResolver,
): EditorialCollector {
  return {
    async collect(rawInput, signal) {
      const input = EditorialJobInputSchema.parse(rawInput);
      throwIfAborted(signal);
      if (resolveHost && input.kind === "url") await assertPublicHttpUrl(input.url, resolveHost);
      let seed: { url: string; document: ScrapedDocument } | undefined;
      let discoveredSources: string[];
      if (input.kind === "url") {
        const url = canonicalEditorialUrl(input.url);
        const document = await provider.scrape(url, { maxAgeMs: 0, signal });
        throwIfAborted(signal);
        seed = { url, document };
        const result = await search({
          query: buildRelatedSearchQuery(seed),
          limit: MAX_PRODUCTION_SEARCH_RESULTS,
          excludeDomains: [new URL(url).hostname],
          signal,
        });
        throwIfAborted(signal);
        discoveredSources = [...result.urls, ...document.links];
      } else {
        const result = await discover({
          prompt: `${PRODUCTION_DISCOVERY_PROMPT}\n${delimit("topic", input.topic)}\n${delimit("context", input.context)}`,
          schema: ProductionDiscoveryJsonSchema,
          model: "spark-1-mini",
          signal,
        });
        throwIfAborted(signal);
        discoveredSources = parseBoundedDiscovery(result.data).sources;
      }
      const candidates = canonicalDiscoveryUrls(input, discoveredSources);
      const publicCandidates: string[] = [];
      for (const url of candidates) {
        throwIfAborted(signal);
        try {
          if (resolveHost) await assertPublicHttpUrl(url, resolveHost);
          publicCandidates.push(url);
        } catch (error) {
          if (seed && url === seed.url) throw error;
        }
      }
      const scraped: Array<{ url: string; document: ScrapedDocument }> = seed ? [seed] : [];
      for (const url of publicCandidates) {
        if (seed && url === seed.url) continue;
        throwIfAborted(signal);
        try {
          const document = await provider.scrape(url, { maxAgeMs: 0, signal });
          throwIfAborted(signal);
          scraped.push({ url, document });
        } catch (error) {
          if (signal.aborted) throw error;
          // A failed candidate is not a canonical anchor; remaining bounded candidates may still suffice.
        }
      }
      const anchors = scraped.map(({ url, document }) => ({
        sourceName: document.title ?? url,
        sourceUrl: url,
        sourceType: "other" as const,
        title: document.title ?? "",
        text: boundUtf8(document.markdown ?? document.html ?? "", MAX_PRODUCTION_ANCHOR_TEXT_BYTES),
        confirmedClaims: [],
        unconfirmedClaims: [],
        interpretationRisk: "No obvious interpretation risk.",
      }));
      return {
        anchors,
        sourceText: boundUtf8(anchors.map((anchor) => [
          `Canonical source URL: ${anchor.sourceUrl}`,
          `Source title: ${anchor.title}`,
          "Source text:",
          anchor.text,
        ].join("\n")).join("\n\n"), MAX_PRODUCTION_SOURCE_TEXT_BYTES),
      };
    },
  };
}

export function createDeepSeekGeneration(client: DeepSeekClient): EditorialGeneration {
  return {
    async research({ job, collection, signal }) {
      const topic = job.kind === "topic" ? job.topic : job.url;
      const result = EditorialResearchSummarySchema.parse(await client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: research. Return only the research summary JSON. Return one anchor object for every canonical source labelled in the collected source text and copy its exact URL. Include only claims materially relevant to the supplied topic; irrelevant sources must have empty claim arrays. The application derives the source gate.` }, { role: "user", content: buildResearchPrompt(job, collection.sourceText ?? "") }], schema: EditorialResearchSummarySchema, signal }));
      const byUrl = new Map(result.anchors.map((anchor) => [canonicalEditorialUrl(anchor.sourceUrl), anchor]));
      const enriched = collection.anchors.map((anchor) => {
        const classified = byUrl.get(canonicalEditorialUrl(anchor.sourceUrl));
        return classified ? { ...anchor, sourceType: classified.sourceType, confirmedClaims: classified.confirmedClaims, unconfirmedClaims: classified.unconfirmedClaims, interpretationRisk: classified.interpretationRisk } : anchor;
      });
      const gate = evaluateSourceGate({ anchors: selectDeterministicEvidenceAnchors(enriched).map(toSourceGateAnchor) });
      return EditorialResearchPackSchema.parse({ topic, context: job.context, summary: result.summary, anchors: enriched, sourceGate: gate });
    },
    async angles({ researchPack, signal }) {
      return client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: angles. Return exactly three angle candidates as JSON.` }, { role: "user", content: buildAnglesPrompt(researchPack) }], schema: EditorialAngleCandidatesSchema, signal });
    },
    async diagnosis({ researchPack, angle, signal }) {
      return client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: diagnosis. Return the diagnosis JSON and ledger.` }, { role: "user", content: buildDiagnosisPrompt(researchPack, angle) }], schema: EditorialDiagnosisSchema, signal });
    },
    async draft({ researchPack, diagnosis, signal }) {
      return client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: draft. Return the draft JSON.` }, { role: "user", content: buildDraftPrompt(researchPack, diagnosis) }], schema: EditorialDraftSchema, signal });
    },
    async formats({ draft, diagnosis, signal }) {
      return client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: formats. Return the six derivatives and exactly ten publication slides JSON.` }, { role: "user", content: buildFormatsPrompt(draft, diagnosis) }], schema: EditorialFormatsSchema, signal });
    },
    async qa({ researchPack, draft, formats, signal }) {
      const editorialLint = parseQaResult(EditorialLintQaSchema, await client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: fixed structured editorial QA. Return only the fixed structured editorial QA JSON.` }, { role: "user", content: buildEditorialQaPrompt(researchPack, draft) }], schema: EditorialLintQaSchema, signal }));
      const formatsLint = parseQaResult(FormatsLintQaSchema, await client.completeJson({ messages: [{ role: "system", content: `${EDITORIAL_SYSTEM_PROMPT}\nStage: fixed structured formats QA. Return only the fixed structured formats QA JSON.` }, { role: "user", content: buildFormatsQaPrompt(draft, formats) }], schema: FormatsLintQaSchema, signal }));
      return combinedEditorialQa(researchPack, draft, editorialLint, formatsLint);
    },
  };
}

const EditorialResearchSummarySchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  anchors: z.array(z.object({
    sourceUrl: z.string().url(),
    sourceType: z.enum(["official", "journalistic", "technical", "policy", "market", "other"]),
    confirmedClaims: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
    unconfirmedClaims: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
    interpretationRisk: z.string().trim().min(1).max(1_000).default("No obvious interpretation risk."),
  }).strict()).max(MAX_PRODUCTION_DISCOVERY_SOURCES).default([]),
}).strict();

function buildDeterministicResearchPack(input: EditorialJobInput, collection: EditorialCollection, generated: EditorialResearchPack): EditorialResearchPack {
  const classifiedByUrl = new Map(generated.anchors.map((anchor) => [canonicalEditorialUrl(anchor.sourceUrl), anchor]));
  const anchorsByUrl = new Map<string, EditorialResearchAnchor>();
  for (const rawAnchor of collection.anchors) {
    const sourceUrl = canonicalEditorialUrl(rawAnchor.sourceUrl);
    if (anchorsByUrl.has(sourceUrl)) continue;
    const classified = classifiedByUrl.get(sourceUrl);
    anchorsByUrl.set(sourceUrl, { ...rawAnchor, ...(classified ? { sourceType: classified.sourceType, confirmedClaims: classified.confirmedClaims, unconfirmedClaims: classified.unconfirmedClaims, interpretationRisk: classified.interpretationRisk } : {}), sourceUrl });
  }
  const anchors = [...anchorsByUrl.values()];
  const sourceGateAnchors = selectDeterministicEvidenceAnchors(anchors).map(toSourceGateAnchor);
  const haystack = `${input.kind === "topic" ? input.topic : input.url} ${input.context}`.toLowerCase();
  const sensitiveCategories = SENSITIVE_CATEGORIES.filter((category) => haystack.includes(category.toLowerCase())) as SensitiveCategory[];
  const sourceGate = evaluateSourceGate({ anchors: sourceGateAnchors, sensitiveCategories });
  const topic = input.kind === "topic" ? input.topic : input.url;
  return EditorialResearchPackSchema.parse({ topic, context: input.context, summary: generated.summary, anchors, sourceGate });
}

function evaluateEditorialQa(researchPack: EditorialResearchPack, draft: EditorialDraft, _formats: EditorialFormats): EditorialQa {
  const missing = evidenceViolations(researchPack, draft, undefined);
  const anchors = researchPack.anchors.map((anchor) => canonicalEditorialUrl(anchor.sourceUrl));
  return EditorialQaSchema.parse({
    passed: missing.length === 0,
    warnings: missing,
    checkedClaims: draft.claims.length,
    sourceUrls: anchors,
  });
}

function combinedEditorialQa(researchPack: EditorialResearchPack, draft: EditorialDraft, editorialLint: EditorialLintQa, formatsLint: FormatsLintQa): EditorialQa {
  const evidenceWarnings = evidenceViolations(researchPack, draft, undefined);
  const passed = evidenceWarnings.length === 0 && qaCheckApproved(editorialLint) && qaCheckApproved(formatsLint);
  return EditorialQaSchema.parse({
    passed,
    warnings: [...evidenceWarnings, ...qaWarnings(editorialLint, "Editorial QA"), ...qaWarnings(formatsLint, "Formats QA")].slice(0, 50),
    checkedClaims: draft.claims.length,
    sourceUrls: researchPack.anchors.map((anchor) => canonicalEditorialUrl(anchor.sourceUrl)),
    editorialLint,
    formatsLint,
  });
}

function parseBoundedDiscovery(value: unknown): z.infer<typeof ProductionDiscoverySchema> {
  const parsed = WebResearchExtractionSchema.parse(value);
  return ProductionDiscoverySchema.parse({ ...parsed, sources: parsed.sources.slice(0, MAX_PRODUCTION_DISCOVERY_SOURCES) });
}

function buildRelatedSearchQuery(seed: { url: string; document: ScrapedDocument }): string {
  const fallback = new URL(seed.url).pathname.split("/").filter(Boolean).join(" ") || new URL(seed.url).hostname;
  const query = (seed.document.title?.trim() || fallback).replace(/\s+/gu, " ").trim();
  return query.slice(0, 500);
}

function canonicalDiscoveryUrls(input: EditorialJobInput, discovered: readonly string[]): string[] {
  const raw = input.kind === "url" ? [input.url, ...discovered] : [...discovered];
  const seen = new Set<string>();
  const seenHosts = new Set<string>();
  const seed = input.kind === "url" ? canonicalEditorialUrl(input.url) : undefined;
  const urls: string[] = [];
  for (const candidate of raw) {
    const parsed = z.string().url().safeParse(candidate);
    if (!parsed.success) continue;
    try {
      const safe = EditorialJobInputSchema.safeParse({ kind: "url", url: candidate, context: "", output: "blog-formats", exportHtml: false });
      if (!safe.success) continue;
      const canonical = canonicalEditorialUrl(candidate);
      if (seen.has(canonical)) continue;
      const candidateUrl = new URL(canonical);
      if (seed && canonical !== seed) {
        if (isLikelyNavigationOrPolicyUrl(candidateUrl)) continue;
        if (seenHosts.has(candidateUrl.hostname)) continue;
      }
      seen.add(canonical);
      seenHosts.add(candidateUrl.hostname);
      urls.push(canonical);
      if (urls.length >= MAX_PRODUCTION_DISCOVERY_SOURCES) break;
    } catch {
      // Invalid, credentialed and private literal targets are discarded before scraping.
    }
  }
  return urls;
}

const NAVIGATION_HOSTS = new Set(["hn.algolia.com", "www.google.com", "bing.com", "duckduckgo.com", "search.brave.com", "search.marginalia.nu"]);
const GOOGLE_HOSTNAME_RE = /(?:^|\.)google\./iu;
const SEARCH_PATH_RE = /(^|\/)search(\/|$)/iu;
const NAVIGATION_PATH_RE = /(?:^|\/)(?:author|authors|category|categories|cookie-policy(?:-[a-z]{2})?|privacy-policy|tag|tags)(?:\/|$)/iu;
const SEARCH_QUERY_PARAMS = new Set(["query", "q", "search", "keyword"]);

export function isLikelyNavigationOrPolicyUrl(url: URL): boolean {
  if (/(?:^|\.)cookiedatabase\.org$/iu.test(url.hostname)) return true;
  if (NAVIGATION_PATH_RE.test(url.pathname)) return true;

  const hostname = url.hostname.toLowerCase();
  if ([...NAVIGATION_HOSTS].some((host) => hostname === host || hostname.endsWith(`.${host}`))) return true;
  if (GOOGLE_HOSTNAME_RE.test(hostname) && SEARCH_PATH_RE.test(url.pathname)) return true;
  if (hostname.startsWith("search.")) return true;
  if (SEARCH_PATH_RE.test(url.pathname)) return true;
  return [...SEARCH_QUERY_PARAMS].some((param) => url.searchParams.has(param));
}

function boundUtf8(value: string, maxBytes: number): string {
  let bytes = Buffer.from(value, "utf8").subarray(0, maxBytes);
  let text = bytes.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    bytes = bytes.subarray(0, -1);
    text = bytes.toString("utf8");
  }
  return text;
}

function stripJsonSchemaMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaMeta);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema").map(([key, child]) => [key, stripJsonSchemaMeta(child)]));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Editorial collection cancelled");
}

function toSourceGateAnchor(anchor: EditorialResearchAnchor): SourceGateAnchor {
  return { sourceName: anchor.sourceName, sourceUrl: anchor.sourceUrl, sourceType: anchor.sourceType, confirmedClaims: anchor.confirmedClaims, unconfirmedClaims: anchor.unconfirmedClaims, interpretationRisk: anchor.interpretationRisk };
}

function selectDeterministicEvidenceAnchors(anchors: readonly EditorialResearchAnchor[]): EditorialResearchAnchor[] {
  const origins = new Set<string>();
  return anchors.filter((anchor) => {
    if (anchor.confirmedClaims.length === 0 && anchor.unconfirmedClaims.length === 0) return false;
    const hostname = new URL(anchor.sourceUrl).hostname.toLowerCase();
    if (origins.has(hostname)) return false;
    origins.add(hostname);
    return true;
  });
}

function evidenceViolations(researchPack: EditorialResearchPack, draft: EditorialDraft | undefined, diagnosis: EditorialDiagnosis | undefined): string[] {
  const anchors = new Set(researchPack.anchors.map((anchor) => canonicalEditorialUrl(anchor.sourceUrl)));
  const warnings: string[] = [];
  if (draft) {
    for (const claim of draft.claims) {
      if (claim.sourceUrls.some((url) => !anchors.has(canonicalEditorialUrl(url)))) warnings.push(`Draft claim cites a URL outside the canonical anchor set: ${claim.claim.slice(0, 120)}`);
    }
  }
  if (diagnosis) {
    for (const entry of diagnosis.ledger) {
      if (entry.classification === "FACTO" && entry.sourceUrls.some((url) => !anchors.has(canonicalEditorialUrl(url)))) warnings.push(`Diagnosis FACTO cites a URL outside the canonical anchor set: ${entry.statement.slice(0, 120)}`);
    }
  }
  return warnings;
}

function validateEditorialEvidence(researchPack: EditorialResearchPack, draft: EditorialDraft | undefined, diagnosis: EditorialDiagnosis | undefined): void {
  const violations = evidenceViolations(researchPack, draft, diagnosis);
  if (violations.length > 0) throw new Error(violations.join("; "));
}

function calculateCanonicalSourceGate(input: EditorialJobInput, anchors: readonly EditorialResearchAnchor[]): EditorialResearchPack["sourceGate"] {
  const haystack = `${input.kind === "topic" ? input.topic : input.url} ${input.context}`.toLowerCase();
  const sensitiveCategories = SENSITIVE_CATEGORIES.filter((category) => haystack.includes(category.toLowerCase())) as SensitiveCategory[];
  return evaluateSourceGate({ anchors: selectDeterministicEvidenceAnchors(anchors).map(toSourceGateAnchor), sensitiveCategories });
}

function assertCanonicalSourceGate(expected: EditorialResearchPack["sourceGate"], persisted: EditorialResearchPack["sourceGate"]): void {
  if (stableJson(expected) !== stableJson(persisted)) throw new Error("The persisted source gate changed before promotion");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function parseQaResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new Error("DeepSeek QA returned invalid structured output") as Error & { code: "generation_invalid" };
  error.code = "generation_invalid";
  throw error;
}

function qaCheckApproved(check: EditorialLintQa | FormatsLintQa): boolean {
  return check.pass === true && check.model_verdict === "PASS";
}

function qaWarnings(check: EditorialLintQa | FormatsLintQa, label: string): string[] {
  return [...check.violations, ...check.sourceRisks, ...check.rhythmRisks].slice(0, 30).map((risk) => `${label}: ${risk}`.slice(0, 500));
}

function isQaApproved(qa: EditorialQa): boolean {
  return qa.passed === true && qa.editorialLint !== undefined && qa.formatsLint !== undefined && qaCheckApproved(qa.editorialLint) && qaCheckApproved(qa.formatsLint);
}

function stageRunning(summaries: EditorialJob["stageSummaries"], stage: EditorialJobStage): EditorialJob["stageSummaries"] {
  return { ...summaries, [stage]: { ...summaries[stage], status: "running", startedAt: new Date().toISOString(), finishedAt: null, warning: null } };
}

function stageForState(state: EditorialJob["state"]): EditorialJobStage | null {
  return ["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa"].includes(state) ? state as EditorialJobStage : null;
}

function retryStage(job: EditorialJob): "researching" | "source_gate" | "diagnosing" | "drafting" | "formatting" | "qa" {
  if (job.error?.code === "human_rejected") return "drafting";
  if (job.failedStage === "source_gate" && job.error?.code !== "source_gate_blocked" && job.stageSummaries.source_gate.status === "completed") return "source_gate";
  if (job.failedStage === "researching" || job.failedStage === "source_gate" || job.failedStage === null) return "researching";
  if (job.failedStage === "qa") return "qa";
  return job.failedStage;
}

function toSafeError(error: unknown, stage: EditorialJobStage): { code: EditorialSafeErrorCode; stage: EditorialJobStage; message: string } {
  const candidate = error as { code?: unknown };
  const code: EditorialSafeErrorCode = candidate.code === "provider_timeout" || candidate.code === "provider_cancelled" || candidate.code === "provider_http" || candidate.code === "provider_invalid_response" || candidate.code === "generation_invalid" ? candidate.code : "unknown";
  const messages: Record<EditorialSafeErrorCode, string> = {
    source_gate_blocked: "Source gate blocked the editorial job",
    human_rejected: "Final editorial approval was rejected",
    provider_timeout: "The generation provider timed out",
    provider_cancelled: "The generation provider was cancelled",
    provider_http: "The generation provider request failed",
    provider_invalid_response: "The generation provider returned invalid structured output",
    generation_invalid: "Generated editorial output failed validation",
    storage_error: "Editorial job storage failed",
    cancelled: "Editorial job cancelled",
    interrupted: "Editorial job was interrupted",
    unknown: "Editorial stage failed",
  };
  return { code, stage, message: messages[code] };
}

function formatEditorialRunnerFailure(jobId: string, stage: EditorialJobStage, code: EditorialSafeErrorCode, error: unknown): string {
  const candidate = error as { message?: unknown; name?: unknown; status?: unknown };
  const name = typeof candidate?.name === "string" && candidate.name.trim() ? candidate.name.trim() : "Error";
  const message = typeof candidate?.message === "string" && candidate.message.trim()
    ? candidate.message.trim()
    : typeof error === "string" && error.trim()
      ? error.trim()
      : "Non-Error rejection";
  const status = typeof candidate?.status === "number" && Number.isFinite(candidate.status)
    ? ` status=${candidate.status}`
    : "";
  return redactSensitiveText(`Editorial runner failure job=${jobId} stage=${stage} code=${code}${status} cause=${name}: ${message}`, 1_500);
}
