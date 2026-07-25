import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadCockpitModel, safeJoin } from "../src/cockpit/adapter.js";
import { evidenceDecision, renderCockpitHtml, renderMarkdownSafe, safeExternalUrl, scrubForDisplay } from "../src/cockpit/renderer.js";
import { createCockpitServer, resolveCockpitHost, startCockpitServer, UNSAFE_HOST_OPT_IN } from "../src/cockpit/server.js";

const fixtureRoot = resolve(process.cwd(), "tests/fixtures/cockpit-data");

test("carrega o read model, escolhe o radar global válido mais recente e lê QA fenced", async () => {
  const model = await loadCockpitModel({ dataDir: fixtureRoot });
  assert.equal(model.readOnly, true);
  assert.equal(model.selectedSlug, "demo-package");
  assert.equal(model.radar.status, "ok");
  assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
  assert.equal(model.radar.value?.global, true);
  assert.equal(model.radar.value?.items[0]?.title, "Uma história útil");
  assert.equal(model.selectedPackage?.formats.length, 7);
  assert.equal(model.selectedPackage?.qa.lint.length, 2);
  assert.equal(model.selectedPackage?.qa.lint.find((item) => item.final)?.artifact.status, "ok");
  assert.ok(model.warnings.some((warning) => warning.includes("corrida radar-hn inválida")));
});

test("degrada artefactos ausentes e malformed sem abortar o pacote", async () => {
  const model = await loadCockpitModel({ dataDir: fixtureRoot }, "broken-package");
  assert.equal(model.selectedPackage?.manifest.status, "malformed");
  assert.equal(model.selectedPackage?.diagnosis.status, "missing");
  assert.equal(model.selectedPackage?.sourceGate.status, "missing");
  assert.ok(model.warnings.some((warning) => warning.includes("publication.json")));
  assert.ok(model.warnings.some((warning) => warning.includes("diagnosis.md")));
});

test("contém caminhos e limpa markdown e URLs perigosos", () => {
  assert.equal(safeJoin(fixtureRoot, "../outside"), undefined);
  assert.equal(safeJoin(fixtureRoot, "/etc/passwd"), undefined);
  assert.equal(safeJoin(fixtureRoot, "editorial/demo-package/publication/../../outside"), undefined);
  assert.equal(safeExternalUrl("javascript:alert(1)"), undefined);
  assert.equal(safeExternalUrl("https://example.com/page?sig=secret#tracking"), "https://example.com/page");
  const html = renderMarkdownSafe("<script>alert(1)</script> [link](javascript:alert(1)) [safe](https://example.com/?token=secret)");
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("token=secret"), false);
});

test("renderiza as seis áreas, avisos, URLs seguras e separação QA", async () => {
  const model = await loadCockpitModel({ dataDir: fixtureRoot });
  const html = renderCockpitHtml(model);
  for (const label of ["Radar", "Fontes", "Diagnóstico", "Draft", "Formatos", "QA"]) assert.ok(html.includes(label));
  assert.ok(html.includes("global"));
  assert.ok(html.includes("Notas humanas"));
  assert.ok(html.includes("não final"));
  assert.equal(html.includes("internal-run-id"), false);
  assert.equal(html.includes("token=remove"), false);
  assert.ok(html.includes("<meta name=\"viewport\""));
});

test("mostra quando o radar foi lido apenas pela cauda, sem depender dos avisos globais", async () => {
  const model = await loadCockpitModel({ dataDir: fixtureRoot });
  model.warnings = [];
  model.radar.truncated = true;
  const html = renderCockpitHtml(model);
  assert.match(html, /Leitura limitada à cauda do ficheiro/u);
});

test("restringe métodos e rotas HTTP", async () => {
  const server = createCockpitServer({ dataDir: fixtureRoot });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (typeof address !== "object" || address === null) throw new Error("server did not bind");
  const port = address.port;
  try {
    const get = await requestText(port, "GET", "/?package=demo-package");
    assert.equal(get.status, 200);
    assert.match(get.body, /Cockpit editorial/u);
    const head = await requestText(port, "HEAD", "/");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const post = await requestText(port, "POST", "/");
    assert.equal(post.status, 405);
    assert.match(post.body, /Método não permitido/u);
    const unknown = await requestText(port, "GET", "/private/path");
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  }
});

test("descarta apenas a linha parcialmente incluída quando a cauda começa a meio da linha", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-radar-"));
  try {
    await mkdir(join(root, "runs"));
    const oldRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-16T10:00:00.000Z", padding: "x".repeat(500) });
    const newestRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-17T10:00:00.000Z" });
    await writeFile(join(root, "runs/runs.jsonl"), `${oldRecord}\n${newestRecord}\n`, "utf8");
    const model = await loadCockpitModel({ dataDir: root, maxRunBytes: Buffer.byteLength(newestRecord) + 8 });
    assert.equal(model.radar.status, "ok");
    assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
    assert.equal(model.radar.truncated, true);
    assert.ok(model.warnings.some((warning) => warning.includes("trecho final")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mantém a primeira linha quando a cauda começa exatamente depois de um newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-radar-boundary-"));
  try {
    await mkdir(join(root, "runs"));
    const oldRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-16T10:00:00.000Z", padding: "x".repeat(500) });
    const newestRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-17T10:00:00.000Z" });
    await writeFile(join(root, "runs/runs.jsonl"), `${oldRecord}\n${newestRecord}\n`, "utf8");
    const model = await loadCockpitModel({ dataDir: root, maxRunBytes: Buffer.byteLength(`${newestRecord}\n`) });
    assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
    assert.equal(model.radar.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agrega avisos de muitas linhas JSONL malformadas", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-radar-warnings-"));
  try {
    await mkdir(join(root, "runs"));
    const newestRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-17T10:00:00.000Z" });
    await writeFile(join(root, "runs/runs.jsonl"), `${"{malformed}\n".repeat(500)}${newestRecord}\n`, "utf8");
    const model = await loadCockpitModel({ dataDir: root });
    const radarWarnings = model.warnings.filter((warning) => warning.includes("registo de corridas"));
    assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
    assert.ok(radarWarnings.length <= 3);
    assert.ok(radarWarnings.some((warning) => warning.includes("500")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignora linhas JSONL demasiado longas antes de materializar o JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-lines-"));
  try {
    await mkdir(join(root, "runs"));
    const longRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-16T10:00:00.000Z", padding: "x".repeat(2_000) });
    const validRecord = JSON.stringify({ command: "radar-hn", output: { items: [] }, createdAt: "2026-07-17T10:00:00.000Z" });
    await writeFile(join(root, "runs/runs.jsonl"), `${longRecord}\n${validRecord}\n`, "utf8");
    const model = await loadCockpitModel({ dataDir: root, maxRunLineBytes: 128 });
    assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
    assert.ok(model.warnings.some((warning) => warning.includes("linha") && warning.includes("limite")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aplica limites de pacotes, ficheiros e orçamento agregado sem abortar", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-budgets-"));
  try {
    await mkdir(join(root, "editorial/alpha"), { recursive: true });
    await mkdir(join(root, "editorial/beta"), { recursive: true });
    await mkdir(join(root, "editorial/gamma"), { recursive: true });
    await writeFile(join(root, "editorial/alpha/publication.json"), "{}", "utf8");
    await writeFile(join(root, "editorial/beta/publication.json"), "{}", "utf8");
    await writeFile(join(root, "editorial/gamma/publication.json"), "{}", "utf8");
    const model = await loadCockpitModel({ dataDir: root, maxPackages: 2, maxFilesPerPackage: 1, maxFileBytes: 1, maxAggregateBytes: 1_000 });
    assert.equal(model.packages.length, 2);
    assert.ok(model.warnings.some((warning) => warning.includes("pacotes")));
    assert.ok(model.warnings.some((warning) => warning.includes("publication.json") && warning.includes("limite")));
    const aggregateModel = await loadCockpitModel({ dataDir: root, maxPackages: 1, maxFilesPerPackage: 1, maxAggregateBytes: 1 });
    assert.ok(aggregateModel.warnings.some((warning) => warning.includes("orçamento agregado")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redige QA aninhado, identificadores internos e URLs com credenciais", async () => {
  const payload = {
    runId: "run_123456789",
    internalRunId: "run_internal",
    executionId: "execution-secret",
    correlation_id: "correlation-secret",
    nested: [{ requestId: "req-secret", document_ids: ["doc_abc"], job_id: "job-secret", taskId: "task-secret", trace_id: "trace-secret", spanId: "span-secret", apiKey: "secret-key", access_token: "bearer-secret", auth: "basic-secret", password: "password-secret", cookie: "cookie-secret", session: "session-secret", private_key: "private-secret", author: "QA author", path: "/tmp/runs/run_path/doc_path/output.json", url: "https://user:password@example.com/path?keep=yes&token=remove&internalRunId=run_query&executionId=execution_query&doc_abc=doc_value" }],
    safe: "https://example.com/ok?keep=yes&access_token=remove&request_id=req_query",
  };
  const scrubbed = JSON.stringify(scrubForDisplay(payload));
  assert.equal(scrubbed.includes("run_123456789"), false);
  assert.equal(scrubbed.includes("run_internal"), false);
  assert.equal(scrubbed.includes("execution-secret"), false);
  assert.equal(scrubbed.includes("correlation-secret"), false);
  assert.equal(scrubbed.includes("doc_abc"), false);
  assert.equal(scrubbed.includes("job-secret"), false);
  assert.equal(scrubbed.includes("task-secret"), false);
  assert.equal(scrubbed.includes("trace-secret"), false);
  assert.equal(scrubbed.includes("span-secret"), false);
  assert.equal(scrubbed.includes("run_path"), false);
  assert.equal(scrubbed.includes("doc_path"), false);
  assert.equal(scrubbed.includes("secret-key"), false);
  assert.ok(scrubbed.includes("QA author"));
  assert.equal(scrubbed.includes("user:password"), false);
  assert.equal(scrubbed.includes("token=remove"), false);
  assert.ok(scrubbed.includes("keep=yes"));
  assert.equal(safeExternalUrl("https://user:password@example.com/path?keep=yes&access_token=remove&internalRunId=run_query&executionId=execution_query&request_id=req_query"), "https://example.com/path?keep=yes");

  const model = await loadCockpitModel({ dataDir: fixtureRoot });
  const evidence = model.selectedPackage?.qa.html[0];
  assert.ok(evidence);
  evidence.artifact = { status: "ok", value: payload };
  const html = renderCockpitHtml(model);
  assert.equal(html.includes("run_123456789"), false);
  assert.equal(html.includes("doc_abc"), false);
  assert.equal(html.includes("password-secret"), false);
});

test("mantém o veredicto do worker e mostra desacordo entre fontes QA", async () => {
  assert.equal(evidenceDecision({ pass: false, model_verdict: "REVIEW" }), "REVIEW");
  assert.equal(evidenceDecision({ pass: false, model_verdict: "PASS" }), "PASS");
  const model = await loadCockpitModel({ dataDir: fixtureRoot });
  const selected = model.selectedPackage;
  assert.ok(selected);
  selected.qa.canonical.value = { ...selected.qa.canonical.value!, pass: false, diagnosisAllowed: false };
  selected.qa.humanNotes.value = "Decisão: REVIEW";
  selected.qa.html[0]!.artifact = { status: "ok", value: { pass: true, model_verdict: "PASS" } };
  const html = renderCockpitHtml(model);
  assert.ok(html.includes("DESACORDO"));
  assert.ok(html.includes("canónico: HOLD"));
  assert.ok(html.includes("humano: REVIEW"));
  assert.ok(html.includes("workers: PASS"));
});

test("aceita hosts loopback normalizados e exige opt-in para hosts inseguros", () => {
  const previous = process.env[UNSAFE_HOST_OPT_IN];
  try {
    delete process.env[UNSAFE_HOST_OPT_IN];
    assert.equal(resolveCockpitHost("127.0.0.1"), "127.0.0.1");
    assert.equal(resolveCockpitHost(" localhost "), "localhost");
    assert.equal(resolveCockpitHost("::1"), "::1");
    assert.equal(resolveCockpitHost("[::1]"), "::1");
    assert.throws(() => resolveCockpitHost("0.0.0.0"), /SCRAPE_AGENT_ALLOW_UNSAFE_HOST/u);
    assert.throws(() => resolveCockpitHost("192.168.1.4"), /SCRAPE_AGENT_ALLOW_UNSAFE_HOST/u);
    process.env[UNSAFE_HOST_OPT_IN] = "true";
    assert.throws(() => resolveCockpitHost("0.0.0.0"), /SCRAPE_AGENT_ALLOW_UNSAFE_HOST/u);
    process.env[UNSAFE_HOST_OPT_IN] = "1";
    assert.equal(resolveCockpitHost("0.0.0.0"), "0.0.0.0");
  } finally {
    if (previous === undefined) delete process.env[UNSAFE_HOST_OPT_IN];
    else process.env[UNSAFE_HOST_OPT_IN] = previous;
  }
});

test("inicia com a configuração de host predefinida em loopback e fecha limpo", async () => {
  const previousHost = process.env.SCRAPE_AGENT_HOST;
  const previousOptIn = process.env[UNSAFE_HOST_OPT_IN];
  let server: Awaited<ReturnType<typeof startCockpitServer>> | undefined;
  try {
    delete process.env.SCRAPE_AGENT_HOST;
    delete process.env[UNSAFE_HOST_OPT_IN];
    server = await startCockpitServer({ dataDir: fixtureRoot, port: 0 });
    const address = server.address();
    assert.equal(typeof address, "object");
    if (typeof address !== "object" || address === null) throw new Error("server did not bind");
    assert.equal(address.address, "127.0.0.1");
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
    if (previousHost === undefined) delete process.env.SCRAPE_AGENT_HOST;
    else process.env.SCRAPE_AGENT_HOST = previousHost;
    if (previousOptIn === undefined) delete process.env[UNSAFE_HOST_OPT_IN];
    else process.env[UNSAFE_HOST_OPT_IN] = previousOptIn;
  }
});

function requestText(port: number, method: string, path: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
