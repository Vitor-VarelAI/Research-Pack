import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  EditorialAngleCandidatesSchema,
  EditorialDraftSchema,
  EditorialFormatsSchema,
  EditorialQaSchema,
} from "../schemas/editorial-generation.js";
import {
  EditorialJobInputSchema,
  EditorialJobSchema,
  type EditorialJob,
  type EditorialJobInput,
  type EditorialJobStage,
  type EditorialJobState,
  redactSensitiveText,
} from "../schemas/editorial-job.js";
import {
  createProductionEditorialRunner,
  inspectProductionEditorialRunnerReadiness,
  type EditorialRunner,
} from "../editorial/run-editorial-job.js";
import { createJobStore, type JobStore } from "../storage/job-store.js";

export const CONTROL_PLANE_MAX_BODY_BYTES = 32_000;
export const CONTROL_PLANE_MAX_NOTE_BYTES = 1_000;
const SAFE_JOB_ID = /^job_[a-f0-9-]{20,}$/u;
const SAFE_ANGLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ACTIVE_STATES = new Set<EditorialJobState>([
  "queued", "researching", "source_gate", "awaiting_angle", "diagnosing", "drafting", "formatting", "qa", "awaiting_final_approval",
]);
const TERMINAL_STATES = new Set<EditorialJobState>(["completed", "failed", "cancelled", "interrupted"]);
const STAGES: readonly EditorialJobStage[] = ["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa"];
const API_ERROR_MESSAGES: Record<string, string> = {
  actions_disabled: "As ações do cockpit estão desligadas.",
  invalid_request: "O pedido não é válido.",
  unauthorized: "O pedido não foi autorizado.",
  not_found: "O processo não foi encontrado.",
  conflict: "Já existe um processo ativo.",
  unavailable: "A operação não está disponível neste momento.",
  runner_not_configured: "O runner editorial ainda não está configurado no serviço.",
  too_large: "O pedido excede o limite permitido.",
};

const SelectAngleSchema = z.object({ angleId: z.string().trim().min(1).max(100).regex(SAFE_ANGLE_ID) }).strict();
const ApprovalSchema = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(CONTROL_PLANE_MAX_NOTE_BYTES).refine((value) => Buffer.byteLength(value, "utf8") <= CONTROL_PLANE_MAX_NOTE_BYTES, "note is too large").optional() }).strict();
const EmptyActionSchema = z.object({}).strict();

export type SafeStage = {
  name: "research" | "source-gate" | "angle" | "diagnosis" | "draft" | "formats" | "qa";
  label: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  warning: string | null;
  artifactKinds: string[];
};

export type SafeReview = {
  title: string;
  description: string;
  qaVerdict: "PASS" | "HOLD" | "REVIEW" | "SEM DECISÃO";
  qaWarnings: string[];
  formatCount: number;
  slideCount: number;
};

export type SafeJob = {
  id: string;
  state: EditorialJobState;
  input: EditorialJobInput;
  createdAt: string;
  updatedAt: string;
  stages: SafeStage[];
  selectedAngle: { id: string; title: string; thesis: string } | null;
  error: { code: string; stage: string | null; message: string } | null;
  angles: Array<{ id: string; title: string; thesis: string; whyNow: string; evidenceCount: number }>;
  review: SafeReview | null;
  packageSlug: string | null;
  rejectionNote: string | null;
};

export type ControlPlaneOptions = {
  dataDir?: string;
  store?: JobStore;
  /** Alias for test seams that name the dependency after the domain object. */
  jobStore?: JobStore;
  runner?: EditorialRunner;
  actionsEnabled?: boolean;
  origin?: string;
  csrfToken?: string;
  environment?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "error">;
};

export type ControlPlane = {
  readonly actionsEnabled: boolean;
  readonly runnerReady: boolean;
  readonly csrfToken: string;
  readonly store: JobStore;
  getJobs(): Promise<SafeJob[]>;
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>;
};

class ControlPlaneError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function createControlPlane(options: ControlPlaneOptions = {}): ControlPlane {
  const environment = options.environment ?? process.env;
  const dataDir = options.dataDir ?? environment.SCRAPE_AGENT_DATA_DIR ?? "data";
  const store = options.store ?? options.jobStore ?? createJobStore(dataDir);
  const requestedActions = options.actionsEnabled ?? environment.SCRAPE_AGENT_COCKPIT_ACTIONS === "1";
  const csrfToken = options.csrfToken ?? randomBytes(32).toString("base64url");
  const configuredOrigin = normalizeConfiguredOrigin(options.origin ?? environment.SCRAPE_AGENT_COCKPIT_ORIGIN);
  const logger = options.logger ?? console;
  // A mutation surface is only advertised when its exact origin is configured;
  // missing origin fails closed instead of showing controls that can never work.
  const actionsEnabled = requestedActions && configuredOrigin !== undefined;
  const productionReadiness = inspectProductionEditorialRunnerReadiness(environment);
  const runnerReady = options.runner !== undefined || productionReadiness.ready;
  // Creating this proxy does not create provider clients. Configuration is
  // resolved only when a ready mutation first asks for the production runner.
  let runner: EditorialRunner | undefined = options.runner;
  let recovery: Promise<void> | undefined;
  const background = new Set<Promise<unknown>>();

  function getRunner(): EditorialRunner {
    if (!runnerReady) throw new ControlPlaneError(503, "runner_not_configured");
    if (!runner) runner = createProductionEditorialRunner(dataDir, environment, logger);
    return runner;
  }

  async function recoverOnce(): Promise<void> {
    if (!recovery) {
      recovery = store.recoverInterrupted().then(() => undefined).catch(() => undefined);
    }
    await recovery;
  }

  async function getJobs(): Promise<SafeJob[]> {
    await recoverOnce();
    const jobs = await store.list();
    return Promise.all(jobs.slice(0, 50).map((job) => toSafeJob(store, job)));
  }

  function runBackground(operation: Promise<unknown>): void {
    const tracked = operation.catch(() => undefined).finally(() => background.delete(tracked));
    background.add(tracked);
  }

  async function requireMutation(request: IncomingMessage): Promise<void> {
    if (!actionsEnabled) {
      await discardRequestBody(request);
      throw new ControlPlaneError(403, "actions_disabled");
    }
    if (request.method !== "POST") throw new ControlPlaneError(405, "invalid_request");
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new ControlPlaneError(415, "invalid_request");
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > CONTROL_PLANE_MAX_BODY_BYTES)) {
      await discardRequestBody(request);
      throw new ControlPlaneError(413, "too_large");
    }
    if (request.headers["sec-fetch-site"] !== "same-origin") throw new ControlPlaneError(403, "unauthorized");
    if (!configuredOrigin || request.headers.origin !== configuredOrigin) throw new ControlPlaneError(403, "unauthorized");
    if (request.headers["x-csrf-token"] !== csrfToken) throw new ControlPlaneError(403, "unauthorized");
  }

  async function parseBody(request: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > CONTROL_PLANE_MAX_BODY_BYTES) {
          await discardRequestBody(request);
          throw new ControlPlaneError(413, "too_large");
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError(400, "invalid_request");
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ControlPlaneError(400, "invalid_request");
    }
  }

  async function startJob(input: EditorialJobInput): Promise<EditorialJob> {
    const candidate = getRunner() as EditorialRunner & { startBackground?: (value: EditorialJobInput) => Promise<EditorialJob> };
    if (candidate.startBackground) return candidate.startBackground(input);
    // Test seams may provide the original runner interface. The operation is
    // deliberately detached so a provider cannot hold the HTTP response.
    const pending = candidate.start(input);
    runBackground(pending);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const jobs = await store.list();
    const job = jobs.find((item) => item.input.kind === input.kind && item.createdAt === jobs[0]?.createdAt) ?? jobs[0];
    if (!job) throw new ControlPlaneError(500, "unavailable");
    return job;
  }

  async function actionJob(action: "select-angle" | "approve" | "reject" | "retry" | "cancel", id: string, body: unknown): Promise<EditorialJob> {
    assertSafeJobId(id);
    await recoverOnce();
    const current = await store.get(id);
    const candidate = getRunner();
    if (action === "select-angle") {
      const parsed = SelectAngleSchema.safeParse(body);
      if (!parsed.success || current.state !== "awaiting_angle") throw new ControlPlaneError(400, "invalid_request");
      runBackground(candidate.selectAngle(id, parsed.data.angleId));
      return current;
    }
    if (action === "approve" || action === "reject") {
      const parsed = ApprovalSchema.safeParse(body);
      if (!parsed.success || current.state !== "awaiting_final_approval") throw new ControlPlaneError(400, "invalid_request");
      if (parsed.data.decision === "approve" && action !== "approve") throw new ControlPlaneError(400, "invalid_request");
      if (parsed.data.decision === "reject" && action !== "reject") throw new ControlPlaneError(400, "invalid_request");
      if (parsed.data.decision === "approve") return candidate.approve(id);
      return candidate.reject(id, parsed.data.note);
    }
    if (action === "retry") {
      if (!EmptyActionSchema.safeParse(body).success || !["failed", "interrupted"].includes(current.state)) throw new ControlPlaneError(400, "invalid_request");
      runBackground(candidate.retry(id));
      return current;
    }
    if (!EmptyActionSchema.safeParse(body).success || !ACTIVE_STATES.has(current.state)) throw new ControlPlaneError(400, "invalid_request");
    // Cancellation updates the persisted state before the response and still
    // aborts the provider through the runner's single cancellation path.
    return candidate.cancel(id);
  }

  async function handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/api/jobs")) return false;
    try {
      await recoverOnce();
      const method = request.method ?? "GET";
      const match = /^\/api\/jobs(?:\/([^/]+))?(?:\/([a-z-]+))?$/u.exec(pathname);
      if (!match) throw new ControlPlaneError(404, "not_found");
      let id: string | undefined;
      try { id = match[1] ? decodeURIComponent(match[1]) : undefined; } catch { throw new ControlPlaneError(404, "not_found"); }
      const action = match[2];
      if (method === "GET" || method === "HEAD") {
        if (action || (id && !SAFE_JOB_ID.test(id))) throw new ControlPlaneError(404, "not_found");
        if (id) {
          const job = await store.get(id);
          await writeJson(response, 200, { job: await toSafeJob(store, job) }, method === "HEAD");
        } else {
          await writeJson(response, 200, { jobs: await getJobs(), actionsEnabled, runnerReady }, method === "HEAD");
        }
        return true;
      }
      if (method !== "POST" || !id && action) throw new ControlPlaneError(404, "not_found");
      await requireMutation(request);
      const body = await parseBody(request);
      if (!id && !action) {
        const parsed = EditorialJobInputSchema.safeParse(body);
        if (!parsed.success) throw new ControlPlaneError(400, "invalid_request");
        let job: EditorialJob;
        try {
          job = await startJob(parsed.data);
        } catch (error) {
          if (error instanceof Error && /one active editorial job|active editorial job lock/iu.test(error.message)) throw new ControlPlaneError(409, "conflict");
          throw error;
        }
        await writeJson(response, 202, { job: await toSafeJob(store, job) });
        return true;
      }
      const allowedAction = action === "select-angle" || action === "approve" || action === "retry" || action === "cancel";
      if (!id || !action || !allowedAction) throw new ControlPlaneError(404, "not_found");
      if (action === "approve") {
        const parsed = ApprovalSchema.safeParse(body);
        if (!parsed.success) throw new ControlPlaneError(400, "invalid_request");
        const job = await actionJob(parsed.data.decision === "approve" ? "approve" : "reject", id, body);
        await writeJson(response, 202, { job: await toSafeJob(store, job) });
        return true;
      }
      const job = await actionJob(action as "select-angle" | "retry" | "cancel", id, body);
      await writeJson(response, 202, { job: await toSafeJob(store, job) });
      return true;
    } catch (error) {
      const safe = error instanceof ControlPlaneError ? error : new ControlPlaneError(500, "unavailable");
      if ((request.method ?? "GET") === "POST" && safe.status >= 500) {
        const cause = safe.code === "runner_not_configured"
          ? `runner configuration unavailable (${productionReadiness.unavailableVariables.join(", ")})`
          : "unexpected operational failure";
        logger.error(`Cockpit mutation failed: ${cause}.`);
      }
      await writeJson(response, safe.status, { error: { code: safe.code, message: API_ERROR_MESSAGES[safe.code] ?? API_ERROR_MESSAGES.unavailable } });
      return true;
    }
  }

  void recoverOnce();
  return { actionsEnabled, runnerReady, csrfToken, store, getJobs, handle };
}

export async function toSafeJob(store: JobStore, job: EditorialJob): Promise<SafeJob> {
  EditorialJobSchema.parse(job);
  const stages: SafeStage[] = [
    safeStage("research", "Pesquisa", job.stageSummaries.researching),
    safeStage("source-gate", "Source gate", job.stageSummaries.source_gate),
    safeStage("angle", "Escolha de ângulo", angleStage(job)),
    safeStage("diagnosis", "Diagnóstico", job.stageSummaries.diagnosing),
    safeStage("draft", "Draft", job.stageSummaries.drafting),
    safeStage("formats", "Formatos", job.stageSummaries.formatting),
    safeStage("qa", "QA", job.stageSummaries.qa),
  ].map((stage) => stage.name === failedStageName(job.failedStage) && stage.status !== "completed" && job.state === "failed" ? { ...stage, status: "failed" } : stage);
  const angles = await readAngles(store, job.id);
  const review = await readReview(store, job.id);
  return {
    id: job.id,
    state: job.state,
    input: safeInput(job.input),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stages,
    selectedAngle: job.selectedAngle ? { id: safeText(job.selectedAngle.id, 100), title: safeText(job.selectedAngle.title, 300), thesis: safeText(job.selectedAngle.thesis, 2_000) } : null,
    error: job.error ? { code: job.error.code, stage: job.error.stage, message: safeErrorMessage(job.error.code) } : null,
    angles,
    review,
    packageSlug: packageSlug(job),
    rejectionNote: job.rejectionNote ? safeText(job.rejectionNote, CONTROL_PLANE_MAX_NOTE_BYTES) : null,
  };
}

function safeStage(name: SafeStage["name"], label: string, summary: { status: SafeStage["status"]; startedAt: string | null; finishedAt: string | null; warning: string | null; artifacts: Array<{ kind: string }> }): SafeStage {
  return {
    name,
    label,
    status: summary.status,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    durationMs: duration(summary.startedAt, summary.finishedAt, summary.status === "running"),
    warning: summary.warning ? safeText(summary.warning, 500) : null,
    artifactKinds: summary.artifacts.map((artifact) => safeText(artifact.kind, 80)).slice(0, 12),
  };
}

function failedStageName(stage: EditorialJob["failedStage"]): SafeStage["name"] | null {
  return stage === "researching" ? "research" : stage === "source_gate" ? "source-gate" : stage === "diagnosing" ? "diagnosis" : stage === "drafting" ? "draft" : stage === "formatting" ? "formats" : stage === "qa" ? "qa" : null;
}

function angleStage(job: EditorialJob): { status: SafeStage["status"]; startedAt: string | null; finishedAt: string | null; warning: string | null; artifacts: Array<{ kind: string }> } {
  if (job.state === "awaiting_angle") return { status: "running", startedAt: job.updatedAt, finishedAt: null, warning: null, artifacts: [] };
  if (["diagnosing", "drafting", "formatting", "qa", "awaiting_final_approval", "completed"].includes(job.state)) return { status: "completed", startedAt: job.createdAt, finishedAt: job.updatedAt, warning: null, artifacts: [{ kind: "angles" }] };
  if (job.failedStage === "source_gate" && job.state === "failed") return { status: "blocked", startedAt: null, finishedAt: null, warning: null, artifacts: [] };
  return { status: "pending", startedAt: null, finishedAt: null, warning: null, artifacts: [] };
}

async function readAngles(store: JobStore, id: string): Promise<SafeJob["angles"]> {
  try {
    const value = EditorialAngleCandidatesSchema.parse(JSON.parse(await store.readArtifact(id, "angles.json")) as unknown);
    return value.candidates.map((candidate) => ({ id: safeText(candidate.id, 100), title: safeText(candidate.title, 300), thesis: safeText(candidate.thesis, 2_000), whyNow: safeText(candidate.whyNow, 2_000), evidenceCount: candidate.evidenceUrls.length }));
  } catch {
    return [];
  }
}

async function readReview(store: JobStore, id: string): Promise<SafeJob["review"]> {
  try {
    const [draft, qa, formats] = await Promise.all([
      store.readArtifact(id, "draft.json").then((value) => EditorialDraftSchema.parse(JSON.parse(value) as unknown)),
      store.readArtifact(id, "qa.json").then((value) => EditorialQaSchema.parse(JSON.parse(value) as unknown)),
      store.readArtifact(id, "formats.json").then((value) => EditorialFormatsSchema.parse(JSON.parse(value) as unknown)),
    ]);
    const editorialVerdict = qa.editorialLint?.model_verdict;
    const formatsVerdict = qa.formatsLint?.model_verdict;
    const qaVerdict = !editorialVerdict || !formatsVerdict
      ? "SEM DECISÃO"
      : editorialVerdict === "REVIEW" || formatsVerdict === "REVIEW"
        ? "REVIEW"
        : qa.passed && qa.editorialLint?.pass === true && qa.formatsLint?.pass === true && editorialVerdict === "PASS" && formatsVerdict === "PASS"
          ? "PASS"
          : "HOLD";
    return { title: safeText(draft.title, 300), description: safeText(draft.description, 1_000), qaVerdict, qaWarnings: safeQaWarnings(qa.warnings), formatCount: 7, slideCount: formats.slides.length };
  } catch {
    return null;
  }
}

function safeQaWarnings(warnings: readonly string[]): string[] {
  const seen = new Set<string>();
  const safeWarnings: string[] = [];
  for (const warning of warnings) {
    const safe = safeText(redactSensitiveText(warning, 500), 500).replace(/https?:\/\/[^\s<>"']+/giu, "[URL omitido]").trim();
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    safeWarnings.push(safe);
    if (safeWarnings.length === 5) break;
  }
  return safeWarnings;
}

function packageSlug(job: EditorialJob): string | null {
  const ref = job.artifacts.find((artifact) => artifact.kind === "publication");
  const match = ref?.path.match(/^editorial\/([a-z0-9]+(?:-[a-z0-9]+)*)\/publication\.json$/u);
  return match?.[1] ?? null;
}

function duration(startedAt: string | null, finishedAt: string | null, running: boolean): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : running ? Date.now() : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.min(end - start, 86_400_000));
}

function safeInput(input: EditorialJobInput): EditorialJobInput {
  return input.kind === "url"
    ? { ...input, context: safeText(input.context, 4_000) }
    : { ...input, topic: safeText(input.topic, 500), context: safeText(input.context, 4_000) };
}

function safeText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/(?:api[_ -]?key|access[_ -]?token|token|secret|authorization|bearer|password|cookie|session)\s*[:=]\s*[^\s,;]+/giu, "[conteúdo omitido]").replace(/(?:\/home\/|\/tmp\/|[A-Z]:\\\\)[^\s<>"]*/gu, "[caminho omitido]").slice(0, max);
}

function safeErrorMessage(code: string): string {
  return code === "source_gate_blocked" ? "O source gate bloqueou o processo." : code === "human_rejected" ? "A aprovação final foi rejeitada." : code === "interrupted" ? "O processo foi interrompido após reinício." : code === "cancelled" ? "O processo foi cancelado." : "A etapa falhou e pode ser repetida.";
}

function assertSafeJobId(value: string): void {
  if (!SAFE_JOB_ID.test(value)) throw new ControlPlaneError(404, "not_found");
}

function normalizeConfiguredOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.origin === "null" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

async function discardRequestBody(request: IncomingMessage): Promise<void> {
  if (request.readableEnded) return;
  await new Promise<void>((resolve) => {
    const done = () => { request.off("end", done); request.off("close", done); request.off("error", done); resolve(); };
    request.once("end", done);
    request.once("close", done);
    request.once("error", done);
    request.resume();
  });
}

async function writeJson(response: ServerResponse, status: number, value: unknown, head = false): Promise<void> {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8").toString(),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(head ? undefined : body);
}
