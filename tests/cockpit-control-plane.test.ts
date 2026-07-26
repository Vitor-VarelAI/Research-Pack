import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCockpitServer } from "../src/cockpit/server.js";
import { toSafeJob } from "../src/cockpit/control-plane.js";
import { inspectProductionEditorialRunnerReadiness, type EditorialRunner } from "../src/editorial/run-editorial-job.js";
import { createJobStore, type JobStore } from "../src/storage/job-store.js";
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

test("production readiness checks every required provider setting without network access", () => {
  const missing = inspectProductionEditorialRunnerReadiness({});
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.unavailableVariables, ["FIRECRAWL_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"]);

  const invalidUrl = inspectProductionEditorialRunnerReadiness({
    FIRECRAWL_API_KEY: "firecrawl-test-value",
    DEEPSEEK_API_KEY: "deepseek-test-value",
    DEEPSEEK_BASE_URL: "not-a-url",
    DEEPSEEK_MODEL: "test-model",
  });
  assert.equal(invalidUrl.ready, false);
  assert.deepEqual(invalidUrl.unavailableVariables, ["DEEPSEEK_BASE_URL"]);

  const invalidOptionalUrl = inspectProductionEditorialRunnerReadiness({
    FIRECRAWL_API_KEY: "firecrawl-test-value",
    FIRECRAWL_BASE_URL: "file:///tmp/provider",
    DEEPSEEK_API_KEY: "deepseek-test-value",
    DEEPSEEK_BASE_URL: "https://provider.invalid/v1",
    DEEPSEEK_MODEL: "test-model",
  });
  assert.equal(invalidOptionalUrl.ready, false);
  assert.deepEqual(invalidOptionalUrl.unavailableVariables, ["FIRECRAWL_BASE_URL"]);

  const ready = inspectProductionEditorialRunnerReadiness({
    FIRECRAWL_API_KEY: "firecrawl-test-value",
    DEEPSEEK_API_KEY: "deepseek-test-value",
    DEEPSEEK_BASE_URL: "https://provider.invalid/v1",
    DEEPSEEK_MODEL: "test-model",
  });
  assert.deepEqual(ready, { ready: true, unavailableVariables: [] });
});

test("requested actions stay unavailable when production providers are not configured", async () => {
  const root = await tempRoot();
  const store = createJobStore({ rootDir: join(root, "control", "jobs") });
  const messages: string[] = [];
  const environment = { FIRECRAWL_API_KEY: "firecrawl-secret-sentinel" };
  try {
    await withServer({
      dataDir: root,
      store,
      actionsEnabled: true,
      origin: "http://cockpit.test",
      environment,
      logger: { error: (message) => messages.push(message) },
    }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      const token = page.body.match(/name="csrf-token" content="([^"]+)"/u)?.[1] ?? "";
      assert.equal(page.status, 200);
      assert.match(page.body, /data-actions-enabled="true" data-runner-ready="false"/u);
      assert.match(page.body, /id="control-status"[^>]*><span[^>]*><\/span>Configuração necessária<\/span>/u);
      assert.match(page.body, /id="new-content"[^>]*disabled/u);

      const list = await requestJson(port, "GET", "/api/jobs");
      assert.deepEqual(list.json, { jobs: [], actionsEnabled: true, runnerReady: false });

      const result = await requestJson(port, "POST", "/api/jobs", input, {
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://cockpit.test",
        "X-CSRF-Token": token,
      });
      assert.equal(result.status, 503);
      assert.deepEqual(result.json, { error: { code: "runner_not_configured", message: "O runner editorial ainda não está configurado no serviço." } });
      assert.deepEqual(await store.list(), []);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, /DEEPSEEK_API_KEY/u);
      assert.match(messages[0]!, /DEEPSEEK_BASE_URL/u);
      assert.match(messages[0]!, /DEEPSEEK_MODEL/u);
      assert.doesNotMatch(messages[0]!, /firecrawl-secret-sentinel/u);
      assert.doesNotMatch(JSON.stringify(result.json), /firecrawl-secret-sentinel/u);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("complete production configuration advertises actions without calling providers", async () => {
  const root = await tempRoot();
  try {
    await withServer({
      dataDir: root,
      actionsEnabled: true,
      origin: "http://cockpit.test",
      environment: {
        FIRECRAWL_API_KEY: "firecrawl-test-value",
        DEEPSEEK_API_KEY: "deepseek-test-value",
        DEEPSEEK_BASE_URL: "https://provider.invalid/v1",
        DEEPSEEK_MODEL: "test-model",
      },
    }, async (port) => {
      const page = await requestJson(port, "GET", "/");
      assert.equal(page.status, 200);
      assert.match(page.body, /Ações disponíveis/u);
      assert.doesNotMatch(page.body, /id="new-content"[^>]*disabled/u);
      const list = await requestJson(port, "GET", "/api/jobs");
      assert.deepEqual(list.json, { jobs: [], actionsEnabled: true, runnerReady: true });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mutations require exact JSON, origin, fetch site and CSRF, then accept topic and URL jobs with an injected runner", async () => {
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
      const initialList = await requestJson(port, "GET", "/api/jobs");
      assert.equal(initialList.json.actionsEnabled, true);
      assert.equal(initialList.json.runnerReady, true);
      assert.match(page.body, /Ações disponíveis/u);
      const created = await requestJson(port, "POST", "/api/jobs", input, base);
      assert.equal(created.status, 202);
      assert.equal(created.json.job.state, "queued");
      assert.deepEqual(created.json.job.input, input);
      assert.equal(created.json.job.angles.length, 0);
      assert.equal(created.json.job.review, null);
      const second = await requestJson(port, "POST", "/api/jobs", input, base);
      assert.equal(second.status, 409);
      const unsafeActionBody = await requestJson(port, "POST", `/api/jobs/${created.json.job.id}/cancel`, { command: "stop" }, base);
      assert.equal(unsafeActionBody.status, 400);
      const cancelled = await requestJson(port, "POST", `/api/jobs/${created.json.job.id}/cancel`, {}, base);
      assert.equal(cancelled.status, 202);
      assert.equal(cancelled.json.job.state, "cancelled");
      const urlInput: EditorialJobInput = { kind: "url", url: "https://example.com/source", context: "Contexto local", output: "blog-formats", exportHtml: true };
      const createdFromUrl = await requestJson(port, "POST", "/api/jobs", urlInput, base);
      assert.equal(createdFromUrl.status, 202);
      assert.deepEqual(createdFromUrl.json.job.input, urlInput);
      const list = await requestJson(port, "GET", "/api/jobs");
      assert.equal(list.status, 200);
      assert.equal(list.json.jobs.length, 2);
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
