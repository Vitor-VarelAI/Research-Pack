import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadCockpitModel, safeJoin } from "../src/cockpit/adapter.js";
import { createCockpitServer } from "../src/cockpit/server.js";
import type { AdapterOptions } from "../src/cockpit/types.js";

const fixtureManifestPath = resolve(process.cwd(), "tests/fixtures/cockpit-data/editorial/demo-package/publication.json");

test("limita profundidade, bytes do JSONL e mantém os artefactos intactos", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-adapter-safety-"));
  try {
    const manifest = JSON.parse(await readFile(fixtureManifestPath, "utf8")) as Record<string, unknown> & {
      formats: Record<string, { path: string }>;
    };
    manifest.formats.blog = { ...manifest.formats.blog, path: "publication/deep/blog.md" };
    await mkdir(join(root, "editorial/demo-package/publication/deep"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    await writeFile(join(root, "editorial/demo-package/publication.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(root, "editorial/demo-package/publication/deep/blog.md"), "conteúdo que não deve ser lido", "utf8");

    const radarRecord = JSON.stringify({
      command: "radar-hn",
      output: { items: [] },
      createdAt: "2026-07-17T10:00:00.000Z",
    });
    await writeFile(join(root, "runs/runs.jsonl"), `${"{malformed:".repeat(200)}\n${radarRecord}\n`, "utf8");

    const before = await readFile(join(root, "editorial/demo-package/publication/deep/blog.md"), "utf8");
    const model = await loadCockpitModel({
      dataDir: root,
      maxDepth: 4,
      maxRunBytes: 4_096,
      maxRunLineBytes: 256,
      maxAggregateBytes: 10_000,
    });
    const blog = model.selectedPackage?.formats.find((format) => format.id === "blog");

    assert.equal(blog?.markdown.status, "missing");
    assert.equal(model.radar.status, "ok");
    assert.ok(model.warnings.some((warning) => warning.includes("linha") && warning.includes("limite")));
    assert.equal(await readFile(join(root, "editorial/demo-package/publication/deep/blog.md"), "utf8"), before);
    assert.equal(safeJoin(root, "editorial/demo-package/publication/deep/blog.md", 4), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partilha o orçamento agregado com runs.jsonl", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-runs-budget-"));
  try {
    await mkdir(join(root, "runs"));
    const record = JSON.stringify({
      command: "radar-hn",
      output: { items: [] },
      createdAt: "2026-07-17T10:00:00.000Z",
    });
    await writeFile(join(root, "runs/runs.jsonl"), `${record}\n`, "utf8");

    const model = await loadCockpitModel({
      dataDir: root,
      maxRunBytes: 10_000,
      maxAggregateBytes: 8,
    });

    assert.equal(model.radar.status, "missing");
    assert.equal(model.radar.truncated, true);
    assert.ok(model.warnings.some((warning) => warning.includes("orçamento agregado")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignora corridas radar acima do limite de itens", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-radar-items-"));
  try {
    await mkdir(join(root, "runs"));
    const item = {
      title: "Sinal",
      url: "https://example.com/story",
      source: "hn",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      rank: 1,
      score: 10,
      commentsCount: 2,
      signals: ["ai-tool"],
      scores: {
        novelty: 1,
        visualStrength: 1,
        practicalUtility: 1,
        domainFit: 1,
        opinionPotential: 1,
        verificationNeed: 1,
        timingStrategy: 1,
        distributionLeverage: 1,
        moneyIncentive: 1,
      },
      totalScore: 8,
      whyCollect: "Tem sinal.",
      possibleAngles: ["Ângulo"],
      strategicQuestions: ["Pergunta"],
      rawSignals: ["AI/model/tool signal"],
    };
    const oversized = JSON.stringify({
      command: "radar-hn",
      output: { items: [item, item] },
      createdAt: "2026-07-18T10:00:00.000Z",
    });
    const valid = JSON.stringify({
      command: "radar-hn",
      output: { items: [item] },
      createdAt: "2026-07-17T10:00:00.000Z",
    });
    await writeFile(join(root, "runs/runs.jsonl"), `${valid}\n${oversized}\n`, "utf8");

    const model = await loadCockpitModel({ dataDir: root, maxRadarItems: 1 });

    assert.equal(model.radar.status, "ok");
    assert.equal(model.radar.value?.generatedAt, "2026-07-17T10:00:00.000Z");
    assert.ok(model.warnings.some((warning) => warning.includes("limite de 1 itens")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limita pacotes e ficheiros sem abortar quando os dados são grandes ou inválidos", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-discovery-budget-"));
  try {
    await mkdir(join(root, "editorial/alpha"), { recursive: true });
    await mkdir(join(root, "editorial/beta"), { recursive: true });
    await mkdir(join(root, "editorial/gamma"), { recursive: true });
    await writeFile(join(root, "editorial/alpha/publication.json"), "{}", "utf8");
    await writeFile(join(root, "editorial/beta/publication.json"), "x".repeat(100), "utf8");
    await writeFile(join(root, "editorial/gamma/publication.json"), "{malformed", "utf8");

    const model = await loadCockpitModel({
      dataDir: root,
      maxPackages: 2,
      maxFilesPerPackage: 1,
      maxFileBytes: 4,
    });

    assert.equal(model.packages.length, 2);
    assert.ok(model.warnings.some((warning) => warning.includes("pacotes")));
    assert.ok(model.warnings.some((warning) => warning.includes("publication.json") && warning.includes("limite")));
    assert.ok(model.warnings.every((warning) => !warning.includes("Error:")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejeita symlink escape e não expõe conteúdo fora do dataDir", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "cockpit-symlink-outside-"));
  try {
    const manifest = JSON.parse(await readFile(fixtureManifestPath, "utf8")) as Record<string, unknown> & {
      formats: Record<string, { path: string }>;
    };
    manifest.formats.blog = { ...manifest.formats.blog, path: "publication/linked.md" };
    await mkdir(join(root, "editorial/safe-package/publication"), { recursive: true });
    await writeFile(join(root, "editorial/safe-package/publication.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(outside, "secret.md"), "conteúdo secreto fora do dataDir", "utf8");
    await symlink(join(outside, "secret.md"), join(root, "editorial/safe-package/publication/linked.md"));
    await symlink(outside, join(root, "editorial/escape"));

    const model = await loadCockpitModel({ dataDir: root });
    const blog = model.selectedPackage?.formats.find((format) => format.id === "blog");
    const serialised = JSON.stringify(model);

    assert.equal(blog?.markdown.status, "missing");
    assert.equal(model.packages.some((item) => item.slug === "escape"), false);
    assert.equal(serialised.includes("conteúdo secreto fora do dataDir"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("o servidor devolve uma página segura quando adapter ou renderer falham", async () => {
  const unsafeOptions = new Proxy({}, {
    get() {
      throw new Error("/home/vitor/private/cockpit-secret");
    },
  }) as unknown as AdapterOptions;
  const server = createCockpitServer(unsafeOptions);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (typeof address !== "object" || address === null) throw new Error("server did not bind");

  try {
    const result = await requestText(address.port, "GET", "/");
    assert.equal(result.status, 500);
    assert.match(result.body, /Cockpit indisponível/u);
    assert.doesNotMatch(result.body, /\/home\/vitor|private\/cockpit-secret|stack|Error:/iu);
    const head = await requestText(address.port, "HEAD", "/");
    assert.equal(head.status, 500);
    assert.equal(head.body, "");
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
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
