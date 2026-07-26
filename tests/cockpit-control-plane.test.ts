import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCockpitServer } from "../src/cockpit/server.js";
import { toSafeJob } from "../src/cockpit/control-plane.js";
import { createJobStore, type JobStore } from "../src/storage/job-store.js";
import type { EditorialRunner } from "../src/editorial/run-editorial-job.js";
import type { EditorialJobInput } from "../src/schemas/editorial-job.js";

const input: EditorialJobInput = { kind: "topic", topic: "Tema local", context: "", output: "blog-formats", exportHtml: false };

function tempRoot(): Promise<string> { return mkdtemp(join(tmpdir(), "cockpit-control-")); }

function fakeRunner(store: JobStore): EditorialRunner {
  return {
    start: async (value) => store.create(value),
    startBackground: async (value) => store.create(value),
    selectAngle: async (id) => store.get(id),
    approve: async (id) => store.get(id),
    reject: async (id) => store.get(id),
    retry: async (id) => store.get(id),
    cancel: async (id) => {
      const job = await store.get(id);
      return store.transition(id, "cancelled", {}, { revision: job.revision, state: job.state });
    },
  };
}

async function withServer<T>(options: Parameters<typeof createCockpitServer>[0], callback: (port: number) => Promise<T>): Promise<T> {
  const server = createCockpitServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { return await callback(address.port); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function requestJson(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, method, path, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, json, body: text, headers: response.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("read-only cockpit starts without provider credentials and exposes only safe job routes", async () => {
  const root = await tempRoot();
  try {
    await withServer({ dataDir: root, actionsEnabled: false }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      assert.equal(page.status, 200);
      assert.match(page.body, /Apenas leitura/u);
      assert.match(page.body, /Novo conteúdo/u);
      assert.match(page.body, /id="compose-value"[^>]*type="url"/u);
      assert.match(page.body, /jobsRoot\?\.addEventListener\('click'/u);
      for (const action of ["angle-select", "approve-job", "reject-job", "retry-job", "cancel-job"]) assert.match(page.body, new RegExp(action));
      const csp = String(page.headers["content-security-policy"]);
      assert.match(csp, /connect-src 'self'/u);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/u);
      const nonce = page.body.match(/<script nonce="([^"]+)"/u)?.[1];
      assert.ok(nonce);
      assert.equal(csp.includes(`'nonce-${nonce}'`), true);
      assert.match(page.body, /disabled/iu);
      for (const forbidden of ["name=\"provider\"", "name=\"model\"", "name=\"prompt\"", "name=\"command\"", "name=\"path\""]) assert.equal(page.body.includes(forbidden), false);
      const disabled = await requestJson(port, "POST", "/api/jobs", input, { "Sec-Fetch-Site": "same-origin", Origin: `http://127.0.0.1:${port}`, "X-CSRF-Token": "wrong" });
      assert.equal(disabled.status, 403);
      assert.equal(disabled.json.error.code, "actions_disabled");
      const generic = await requestJson(port, "GET", "/api/jobs/job_12345678901234567890/command");
      assert.equal(generic.status, 404);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mutations require exact JSON, origin, fetch site and CSRF, then return a background job", async () => {
  const root = await tempRoot();
  const store = createJobStore({ rootDir: join(root, "control", "jobs") });
  try {
    await withServer({ dataDir: root, store, runner: fakeRunner(store), actionsEnabled: true, origin: "http://cockpit.test" }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      const token = page.body.match(/name="csrf-token" content="([^"]+)"/u)?.[1];
      assert.ok(token);
      const base = { "Sec-Fetch-Site": "same-origin", Origin: "http://cockpit.test", "X-CSRF-Token": token! };
      const missingOrigin = await requestJson(port, "POST", "/api/jobs", input, { ...base, Origin: "http://other.test" });
      assert.equal(missingOrigin.status, 403);
      const malformed = await requestJson(port, "POST", "/api/jobs", { ...input, command: "ls" }, base);
      assert.equal(malformed.status, 400);
      const created = await requestJson(port, "POST", "/api/jobs", input, base);
      assert.equal(created.status, 202);
      assert.equal(created.json.job.state, "queued");
      assert.equal(created.json.job.angles.length, 0);
      assert.equal(created.json.job.review, null);
      const second = await requestJson(port, "POST", "/api/jobs", input, base);
      assert.equal(second.status, 409);
      const unsafeActionBody = await requestJson(port, "POST", `/api/jobs/${created.json.job.id}/cancel`, { command: "stop" }, base);
      assert.equal(unsafeActionBody.status, 400);
      const cancelled = await requestJson(port, "POST", `/api/jobs/${created.json.job.id}/cancel`, {}, base);
      assert.equal(cancelled.status, 202);
      assert.equal(cancelled.json.job.state, "cancelled");
      const list = await requestJson(port, "GET", "/api/jobs");
      assert.equal(list.status, 200);
      assert.equal(list.json.jobs.length, 1);
      assert.equal(JSON.stringify(list.json).includes("/home/"), false);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incomplete structured QA remains undecided in the safe review model", async () => {
  const root = await tempRoot();
  const store = createJobStore({ rootDir: join(root, "control", "jobs") });
  try {
    const job = await store.create(input);
    await store.writeArtifact(job.id, "draft.json", JSON.stringify({ title: "Draft", description: "Descrição", bodyMarkdown: "# Draft", claims: [] }));
    const themes = ["ink", "paper", "blue", "sand", "red", "paper", "blue", "sand", "red", "ink"];
    await store.writeArtifact(job.id, "formats.json", JSON.stringify({ newsletter: "N", linkedin: "L", xThread: "X", shortVideoIdeas: "V", carousel: "C", titlesHooks: "T", slides: themes.map((theme, index) => ({ id: `slide-${index}`, eyebrow: "E", title: "T", bodyMarkdown: "B", theme })) }));
    await store.writeArtifact(job.id, "qa.json", JSON.stringify({ passed: true, warnings: [], checkedClaims: 0, sourceUrls: [] }));
    assert.equal((await toSafeJob(store, job)).review?.qaVerdict, "SEM DECISÃO");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("approval failures return a safe error instead of an optimistic 202", async () => {
  const root = await tempRoot();
  const store = createJobStore({ rootDir: join(root, "control", "jobs") });
  try {
    let job = await store.create(input);
    for (const state of ["researching", "source_gate", "awaiting_angle", "diagnosing", "drafting", "formatting", "qa", "awaiting_final_approval"] as const) {
      job = await store.transition(job.id, state, {}, { revision: job.revision, state: job.state });
    }
    const runner: EditorialRunner = { ...fakeRunner(store), approve: async () => { throw new Error("promotion failed"); }, reject: async () => { throw new Error("rejection failed"); } };
    await withServer({ dataDir: root, store, runner, actionsEnabled: true, origin: "http://cockpit.test" }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      const token = page.body.match(/name="csrf-token" content="([^"]+)"/u)?.[1] ?? "";
      const result = await requestJson(port, "POST", `/api/jobs/${job.id}/approve`, { decision: "approve" }, { "Sec-Fetch-Site": "same-origin", Origin: "http://cockpit.test", "X-CSRF-Token": token });
      assert.equal(result.status, 500);
      assert.equal(result.json.error.code, "unavailable");
      assert.equal((await store.get(job.id)).state, "awaiting_final_approval");
      const rejection = await requestJson(port, "POST", `/api/jobs/${job.id}/approve`, { decision: "reject", note: "Rever abertura" }, { "Sec-Fetch-Site": "same-origin", Origin: "http://cockpit.test", "X-CSRF-Token": token });
      assert.equal(rejection.status, 500);
      assert.equal(rejection.json.error.code, "unavailable");
      assert.equal((await store.get(job.id)).state, "awaiting_final_approval");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("body limits and traversal IDs fail with safe JSON", async () => {
  const root = await tempRoot();
  try {
    await withServer({ dataDir: root, actionsEnabled: true, origin: "http://cockpit.test" }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      const token = page.body.match(/name="csrf-token" content="([^"]+)"/u)?.[1] ?? "";
      const headers = { "Sec-Fetch-Site": "same-origin", Origin: "http://cockpit.test", "X-CSRF-Token": token, "Content-Type": "application/json" };
      const large = await requestJson(port, "POST", "/api/jobs", "x".repeat(40_000), headers);
      assert.equal(large.status, 413);
      const traversal = await requestJson(port, "GET", "/api/jobs/%2e%2e%2fprivate");
      assert.equal(traversal.status, 404);
      assert.equal(traversal.json.error.message.includes("private"), false);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
