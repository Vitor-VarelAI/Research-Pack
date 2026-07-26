import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertEditorialJobTransition,
  createEmptyStageSummaries,
  EditorialJobInputSchema,
  EditorialJobSchema,
  sanitizeEditorialJobInput,
  redactSensitiveText,
  EditorialJobEventSchema,
  isExecutingEditorialJobState,
  isHumanGateEditorialJobState,
  type EditorialArtifactRef,
  type EditorialJob,
  type EditorialJobError,
  type EditorialJobEvent,
  type EditorialJobInput,
  type EditorialJobState,
  type EditorialJobStage,
} from "../schemas/editorial-job.js";
import { nowIso } from "../util.js";

export type JobStoreOptions = {
  dataRoot?: string;
  /** Direct root override for isolated tests. Production uses dataRoot/control/jobs. */
  rootDir?: string;
  maxEvents?: number;
  maxEventBytes?: number;
  maxArtifactBytes?: number;
};

export type JobTransitionPatch = {
  stageSummaries?: EditorialJob["stageSummaries"];
  selectedAngle?: EditorialJob["selectedAngle"];
  artifacts?: EditorialArtifactRef[];
  error?: EditorialJobError | null;
  failedStage?: EditorialJob["failedStage"];
  rejectionNote?: EditorialJob["rejectionNote"];
};

export type JobStore = {
  readonly rootDir: string;
  create(input: EditorialJobInput): Promise<EditorialJob>;
  get(id: string): Promise<EditorialJob>;
  list(): Promise<EditorialJob[]>;
  transition(id: string, state: EditorialJobState, patch?: JobTransitionPatch, expected?: { revision?: number; state?: EditorialJobState }): Promise<EditorialJob>;
  update(id: string, patch: JobTransitionPatch, expected?: { revision?: number; state?: EditorialJobState }): Promise<EditorialJob>;
  appendEvent(id: string, event: Omit<EditorialJobEvent, "sequence" | "at"> & { at?: string }): Promise<EditorialJobEvent>;
  events(id: string): Promise<EditorialJobEvent[]>;
  writeArtifact(id: string, relativePath: string, content: string | Uint8Array): Promise<EditorialArtifactRef>;
  readArtifact(id: string, relativePath: string): Promise<string>;
  recoverInterrupted(): Promise<EditorialJob[]>;
  recover(): Promise<EditorialJob[]>;
  releaseActive(id: string): Promise<void>;
};

const TERMINAL_STATES = new Set<EditorialJobState>(["completed", "failed", "cancelled", "interrupted"]);
const JOB_ID_PATTERN = /^job_[a-f0-9-]{20,}$/u;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_EVENT_BYTES = 256_000;

export function JobStore(dataRootOrOptions: string | JobStoreOptions = process.env.SCRAPE_AGENT_DATA_DIR ?? "data"): JobStore {
  return createJobStore(dataRootOrOptions);
}

export const openJobStore = JobStore;
export const createEditorialJobStore = JobStore;

export function createJobStore(dataRootOrOptions: string | JobStoreOptions = process.env.SCRAPE_AGENT_DATA_DIR ?? "data"): JobStore {
  const options: JobStoreOptions = typeof dataRootOrOptions === "string" ? { dataRoot: dataRootOrOptions } : dataRootOrOptions;
  const rootDir = path.resolve(options.rootDir ?? path.join(options.dataRoot ?? "data", "control", "jobs"));
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxArtifactBytes = options.maxArtifactBytes ?? 2_000_000;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer");
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 256) throw new Error("maxEventBytes must be at least 256");
  if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1_024) throw new Error("maxArtifactBytes must be at least 1024");

  let mutationTail = Promise.resolve();
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationTail.then(operation);
    mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async function ensureRoot(): Promise<void> {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await assertDirectory(rootDir, "job store root");
  }

  function jobDir(id: string): string {
    assertJobId(id);
    return path.join(rootDir, id);
  }

  function jobFile(id: string): string {
    return path.join(jobDir(id), "job.json");
  }

  function eventsFile(id: string): string {
    return path.join(jobDir(id), "events.jsonl");
  }

  async function readJob(id: string, createRoot = true): Promise<EditorialJob> {
    if (createRoot) await ensureRoot();
    else await assertDirectory(rootDir, "job store root");
    const directory = jobDir(id);
    await assertDirectory(directory, "job directory");
    const file = jobFile(id);
    await assertRegularFile(file, "job.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Invalid job.json for ${id}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
    return EditorialJobSchema.parse(raw);
  }

  async function writeJob(job: EditorialJob): Promise<void> {
    EditorialJobSchema.parse(job);
    const directory = jobDir(job.id);
    await assertDirectory(directory, "job directory");
    const target = jobFile(job.id);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function appendEventInternal(id: string, event: Omit<EditorialJobEvent, "sequence" | "at"> & { at?: string }): Promise<EditorialJobEvent> {
    const file = eventsFile(id);
    await assertRegularFileIfPresent(file, "events.jsonl");
    let existing = "";
    try { existing = await readFile(file, "utf8"); } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const lines = existing === "" ? [] : existing.trimEnd().split("\n").filter(Boolean);
    if (lines.length >= maxEvents) throw new Error(`Job event limit reached (${maxEvents})`);
    const sequence = lines.length + 1;
    const parsed = EditorialJobEventSchema.parse({ ...event, message: redactSensitiveText(event.message, 500), sequence, at: event.at ?? nowIso() });
    const serialized = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(existing, "utf8") + Buffer.byteLength(serialized, "utf8") > maxEventBytes) {
      throw new Error(`Job event byte limit reached (${maxEventBytes})`);
    }
    const handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.write(Buffer.from(serialized, "utf8"));
    } finally {
      await handle.close();
    }
    return parsed;
  }

  async function releaseActiveInternal(id: string): Promise<void> {
    await ensureRoot();
    const lock = path.join(rootDir, "active.lock");
    await assertRegularFileIfPresent(lock, "active lock");
    try {
      const raw = JSON.parse(await readFile(lock, "utf8")) as { id?: unknown };
      if (raw.id === id) await unlink(lock);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async function acquireActive(id: string): Promise<void> {
    const lock = path.join(rootDir, "active.lock");
    await assertRegularFileIfPresent(lock, "active lock");
    try {
      const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.write(Buffer.from(`${JSON.stringify({ id })}\n`, "utf8")); } finally { await handle.close(); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let lockId: string | undefined;
    try {
      const raw = JSON.parse(await readFile(lock, "utf8")) as { id?: unknown };
      if (typeof raw.id === "string") lockId = raw.id;
    } catch {
      throw new Error("An active editorial job lock exists");
    }
    if (!lockId || !JOB_ID_PATTERN.test(lockId)) throw new Error("An active editorial job lock exists");
    try {
      const current = await readJob(lockId);
      if (!TERMINAL_STATES.has(current.state)) throw new Error("Only one active editorial job is allowed");
    } catch (error) {
      if (error instanceof Error && error.message.includes("Only one active")) throw error;
      if (!(error instanceof Error) || !error.message.includes("job.json does not exist")) throw new Error("An active editorial job lock exists");
    }
    await unlink(lock).catch((error: unknown) => { if (!isNotFound(error)) throw error; });
    const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.write(Buffer.from(`${JSON.stringify({ id })}\n`, "utf8")); } finally { await handle.close(); }
  }

  async function releaseActive(id: string): Promise<void> {
    return mutate(() => releaseActiveInternal(id));
  }

  function applyPatch(job: EditorialJob, patch: JobTransitionPatch, state: EditorialJobState): EditorialJob {
    const safePatch: JobTransitionPatch = {
      ...patch,
      ...(patch.error ? { error: { ...patch.error, message: redactSensitiveText(patch.error.message, 500) } } : {}),
      ...(patch.rejectionNote ? { rejectionNote: redactSensitiveText(patch.rejectionNote, 1_000) } : {}),
    };
    return EditorialJobSchema.parse({
      ...job,
      ...safePatch,
      state,
      revision: job.revision + 1,
      updatedAt: nowIso(),
    });
  }

  async function assertExpected(job: EditorialJob, expected?: { revision?: number; state?: EditorialJobState }): Promise<void> {
    if (expected?.revision !== undefined && job.revision !== expected.revision) throw new Error(`Job revision changed for ${job.id}`);
    if (expected?.state !== undefined && job.state !== expected.state) throw new Error(`Job state changed for ${job.id}`);
  }

  return {
    rootDir,

    async create(input: EditorialJobInput): Promise<EditorialJob> {
      return mutate(async () => {
      const parsedInput = sanitizeEditorialJobInput(input);
      await ensureRoot();
      const id = `job_${randomUUID()}`;
      await acquireActive(id);
      const directory = jobDir(id);
      try {
        await mkdir(directory, { mode: 0o700 });
        const at = nowIso();
        const job = EditorialJobSchema.parse({
          id,
          revision: 1,
          state: "queued",
          input: parsedInput,
          createdAt: at,
          updatedAt: at,
          stageSummaries: createEmptyStageSummaries(),
          selectedAngle: null,
          artifacts: [],
          error: null,
          failedStage: null,
          rejectionNote: null,
        });
        await writeJob(job);
        await appendEventInternal(id, { state: "queued", type: "created", message: "Editorial job created", at });
        return job;
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        await releaseActiveInternal(id);
        throw error;
      }
      });
    },

    get: readJob,

    async list(): Promise<EditorialJob[]> {
      await ensureRoot();
      const entries = await readdir(rootDir, { withFileTypes: true });
      const jobs: EditorialJob[] = [];
      for (const entry of entries) {
        if (!JOB_ID_PATTERN.test(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error(`Job directory must not be a symlink: ${entry.name}`);
        if (!entry.isDirectory()) throw new Error(`Job directory is not a directory: ${entry.name}`);
        try {
          jobs.push(await readJob(entry.name));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("job.json does not exist")) throw error;
        }
      }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async transition(id, state, patch = {}, expected): Promise<EditorialJob> {
      return mutate(async () => {
      const current = await readJob(id);
      await assertExpected(current, expected);
      assertEditorialJobTransition(current.state, state);
      const next = applyPatch(current, patch, state);
      await writeJob(next);
      await appendEventInternal(id, {
        state,
        type: state === "cancelled" ? "cancelled" : state === "failed" ? "error" : "transition",
        message: patch.error?.message ?? `Editorial job entered ${state}`,
      });
      if (TERMINAL_STATES.has(state)) await releaseActiveInternal(id);
      return next;
      });
    },

    async update(id, patch, expected): Promise<EditorialJob> {
      return mutate(async () => {
      const current = await readJob(id);
      await assertExpected(current, expected);
      const safePatch: JobTransitionPatch = {
        ...patch,
        ...(patch.error ? { error: { ...patch.error, message: redactSensitiveText(patch.error.message, 500) } } : {}),
        ...(patch.rejectionNote ? { rejectionNote: redactSensitiveText(patch.rejectionNote, 1_000) } : {}),
      };
      const next = EditorialJobSchema.parse({ ...current, ...safePatch, revision: current.revision + 1, updatedAt: nowIso() });
      await writeJob(next);
      return next;
      });
    },

    async appendEvent(id, event) {
      return mutate(async () => {
        await readJob(id);
        return appendEventInternal(id, event);
      });
    },

    async events(id): Promise<EditorialJobEvent[]> {
      await readJob(id);
      const file = eventsFile(id);
      await assertRegularFileIfPresent(file, "events.jsonl");
      let raw = "";
      try { raw = await readFile(file, "utf8"); } catch (error) { if (!isNotFound(error)) throw error; }
      return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map((line) => EditorialJobEventSchema.parse(JSON.parse(line)));
    },

    async writeArtifact(id, relativePath, content): Promise<EditorialArtifactRef> {
      return mutate(async () => {
      const job = await readJob(id);
      const safePath = safeRelativePath(relativePath);
      const target = path.resolve(jobDir(id), safePath);
      const relativeToStore = path.relative(rootDir, target).split(path.sep).join("/");
      if (!relativeToStore.startsWith(`${id}/`)) throw new Error("Artifact path escapes job directory");
      if (Buffer.byteLength(content) > maxArtifactBytes) throw new Error(`Artifact exceeds the size limit (${maxArtifactBytes})`);
      await ensureParentChain(jobDir(id), target);
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        const safeContent = typeof content === "string" ? redactSensitiveText(content, maxArtifactBytes) : content;
        await writeFile(temporary, safeContent, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { kind: path.basename(safePath), path: relativeToStore, createdAt: nowIso() };
      });
    },

    async readArtifact(id, relativePath): Promise<string> {
      await readJob(id, false);
      const safePath = safeRelativePath(relativePath);
      const target = path.resolve(jobDir(id), safePath);
      const relativeToJob = path.relative(jobDir(id), target);
      if (relativeToJob === "" || relativeToJob.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToJob)) throw new Error("Artifact path escapes job directory");
      await assertExistingParentChain(jobDir(id), target);
      await assertRegularFile(target, "artifact");
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("artifact is not a regular file");
        if (info.size > maxArtifactBytes) throw new Error(`artifact exceeds the size limit (${maxArtifactBytes})`);
        return await readBoundedHandle(handle, maxArtifactBytes);
      } finally {
        await handle.close();
      }
    },

    async recoverInterrupted(): Promise<EditorialJob[]> {
      return mutate(async () => {
      const jobs = await this.list();
      const recovered: EditorialJob[] = [];
      for (const job of jobs) {
        if (!isExecutingEditorialJobState(job.state) || isHumanGateEditorialJobState(job.state)) continue;
        const failedStage = isEditorialJobStage(job.state) ? job.state : null;
        const error: EditorialJobError = { code: "interrupted", stage: failedStage, message: "Job was interrupted during service restart" };
        const current = await readJob(job.id);
        await assertExpected(current, { revision: job.revision, state: job.state });
        assertEditorialJobTransition(current.state, "interrupted");
        const next = applyPatch(current, { error, failedStage }, "interrupted");
        await writeJob(next);
        await appendEventInternal(job.id, { state: "interrupted", type: "recovered", message: "Running job marked interrupted after restart" });
        recovered.push(next);
      }
      return recovered;
      });
    },

    async recover(): Promise<EditorialJob[]> {
      return this.recoverInterrupted();
    },

    releaseActive,
  };
}

const EDITORIAL_JOB_STAGE_NAMES = new Set<string>(["researching", "source_gate", "diagnosing", "drafting", "formatting", "qa"]);

function isEditorialJobStage(state: EditorialJobState): state is EditorialJobStage {
  return EDITORIAL_JOB_STAGE_NAMES.has(state);
}

function assertJobId(id: string): void {
  if (!JOB_ID_PATTERN.test(id)) throw new Error("Invalid job id");
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) throw new Error("Artifact path must be relative");
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error("Artifact path contains traversal or empty segments");
  return segments.join(path.sep);
}

async function assertExistingParentChain(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Artifact path escapes job directory");
  const segments = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]!);
    await assertDirectory(current, "artifact parent");
  }
}

async function ensureParentChain(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Artifact path escapes job directory");
  const segments = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]!);
    try {
      await assertDirectory(current, "artifact parent");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("does not exist")) throw error;
      await mkdir(current, { mode: 0o700 });
      await assertDirectory(current, "artifact parent");
    }
  }
}

async function assertDirectory(filePath: string, description: string): Promise<void> {
  let info;
  try { info = await lstat(filePath); } catch { throw new Error(`${description} does not exist`); }
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${description} is not a directory`);
}

async function assertRegularFile(filePath: string, description: string): Promise<void> {
  let info;
  try { info = await lstat(filePath); } catch { throw new Error(`${description} does not exist`); }
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symlink`);
  if (!info.isFile()) throw new Error(`${description} is not a regular file`);
}

async function readBoundedHandle(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
    const result = await handle.read(buffer, 0, buffer.byteLength, null);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    chunks.push(buffer.subarray(0, result.bytesRead));
    if (total > maxBytes) throw new Error(`artifact exceeds the size limit (${maxBytes})`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertRegularFileIfPresent(filePath: string, description: string): Promise<void> {
  try { await assertRegularFile(filePath, description); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("does not exist")) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
