import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderCockpitHtml, renderMarkdownSafe, safeExternalUrl } from "../src/cockpit/renderer.js";
import type { CockpitModel } from "../src/cockpit/types.js";

const XSS = `"><img src=x onerror="alert(1)"><script>alert(1)</script>`;

test("escapa payloads de data/editorial em texto, atributos e JSON sem criar HTML executável", () => {
  const model = makeModel();
  const selected = model.selectedPackage!;
  const publication = selected.manifest.value as Record<string, unknown>;
  publication.title = XSS;
  publication.description = XSS;
  selected.slug = XSS;
  selected.diagnosis.value = `[texto](${XSS})\n\n${XSS}`;
  selected.draft.value = XSS;
  selected.formats[0]!.id = XSS as never;
  selected.formats[0]!.label = XSS;
  selected.formats[0]!.markdown.value = XSS;
  selected.qa.humanNotes.value = XSS;
  selected.qa.html[0]!.provider = XSS;
  selected.qa.html[0]!.artifact = { status: "ok", value: { payload: XSS, closing: "</script><script>alert(2)</script>" } };
  selected.sourceGate.value!.anchors[0]!.sourceName = XSS;
  selected.sourceGate.value!.anchors[0]!.interpretationRisk = XSS;
  model.warnings = [XSS];
  model.freshness = XSS;
  model.radar.value!.items[0]!.source = XSS;
  model.radar.value!.items[0]!.title = XSS;
  model.radar.value!.items[0]!.whyCollect = XSS;
  model.radar.value!.items[0]!.possibleAngles = [XSS];
  model.radar.value!.items[0]!.strategicQuestions = [XSS];

  const html = renderCockpitHtml(model);

  assert.equal(/<(?:script|img|svg)\b[^>]*(?:alert|onerror|onload)/iu.test(html), false);
  assert.equal(/<script[^>]*>alert/iu.test(html), false);
  assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
  assert.equal(html.includes("&quot;&gt;&lt;img"), true);
  assert.equal(html.includes("onfocus=\"alert"), false);
  assert.equal(html.includes("</script><script>alert(2)</script>"), false);
});

test("aceita apenas links HTTP(S) e remove o href quando o valor não é navegável", () => {
  assert.equal(safeExternalUrl("https://example.com/path?token=secret"), "https://example.com/path");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:editor@example.com",
    "not a URL",
    "https://[malformed",
  ]) {
    assert.equal(safeExternalUrl(value), undefined, value);
  }

  const model = makeModel();
  const item = model.radar.value!.items[0]!;
  item.url = "javascript:alert(1)";
  model.selectedPackage!.sourceGate.value!.anchors[0]!.sourceUrl = "data:text/html,alert(1)";
  const html = renderCockpitHtml(model);

  assert.equal(html.includes('href="javascript:'), false);
  assert.equal(html.includes('href="data:'), false);
  assert.equal(html.includes("URL não disponível"), true);
  assert.match(renderMarkdownSafe("[mail](mailto:editor@example.com) [bad](javascript:alert(1))"), /<a target="_blank"/u);
  assert.equal(renderMarkdownSafe("[mail](mailto:editor@example.com)").includes('href="mailto:'), false);
});

test("mantém QA incompleto, falhado ou contraditório fora de PASS", () => {
  const incomplete = makeModel();
  incomplete.selectedPackage!.qa.humanNotes.value = "A revisão humana ainda não tem decisão explícita.";
  incomplete.selectedPackage!.qa.html = [];
  incomplete.selectedPackage!.qa.factCheck = [{ ...evidence("fact-check"), artifact: { status: "ok", value: { pass: true } } }];
  const incompleteReconciliation = reconciliationBlock(renderCockpitHtml(incomplete));
  assert.match(incompleteReconciliation, /<strong>SEM DECISÃO<\/strong>/u);
  assert.doesNotMatch(incompleteReconciliation, /<strong>PASS<\/strong>/u);

  const contradictory = makeModel();
  contradictory.selectedPackage!.qa.humanNotes.value = "Decisão: PASS";
  contradictory.selectedPackage!.qa.html = [{
    ...evidence("html"),
    artifact: { status: "ok", value: { pass: false, model_verdict: "PASS" } },
  }];
  const contradictoryHtml = renderCockpitHtml(contradictory);
  assert.match(reconciliationBlock(contradictoryHtml), /<strong>DESACORDO<\/strong>/u);
  assert.match(contradictoryHtml, />CONTRADITÓRIO<\/b>/u);

  const failed = makeModel();
  failed.selectedPackage!.qa.humanNotes.value = "Decisão: PASS";
  failed.selectedPackage!.qa.factCheck = [{
    ...evidence("fact-check"),
    artifact: { status: "malformed", detail: "JSON inválido." },
  }];
  const failedReconciliation = reconciliationBlock(renderCockpitHtml(failed));
  assert.match(failedReconciliation, /<strong>SEM DECISÃO<\/strong>/u);
  assert.doesNotMatch(failedReconciliation, /<strong>PASS<\/strong>/u);

  const narrativeVerdict = makeModel();
  narrativeVerdict.selectedPackage!.qa.humanNotes.value = "Decisão: PASS";
  narrativeVerdict.selectedPackage!.qa.html = [{
    ...evidence("html"),
    artifact: {
      status: "ok",
      value: {
        pass: false,
        model_verdict: "Não passou. Há violações editoriais a corrigir.",
      },
    },
  }];
  const narrativeHtml = renderCockpitHtml(narrativeVerdict);
  assert.match(narrativeHtml, />HOLD<\/b>/u);
  assert.doesNotMatch(narrativeHtml, />CONTRADITÓRIO<\/b>/u);
});

function reconciliationBlock(html: string): string {
  return html.match(/<article class="qa-reconciliation[^>]*>[\s\S]*?<\/article>/u)?.[0] ?? "";
}

function evidence(kind: "html" | "fact-check") {
  return {
    filename: `${kind}-qa.json`,
    provider: "test",
    final: true,
    kind,
    artifact: { status: "ok" as const, value: { pass: true } },
  };
}

function makeModel(): CockpitModel {
  const gate = {
    pass: true,
    minimumAnchorsFound: 3,
    needsExtraAnchor: false,
    sensitiveCategories: [],
    anchors: [
      {
        sourceName: "Fonte oficial",
        sourceUrl: "https://example.com/official",
        sourceType: "official",
        confirmedClaims: ["Claim confirmado"],
        unconfirmedClaims: [],
        interpretationRisk: "Risco controlado.",
      },
      {
        sourceName: "Fonte técnica",
        sourceUrl: "https://example.org/technical",
        sourceType: "technical",
        confirmedClaims: [],
        unconfirmedClaims: [],
        interpretationRisk: "Risco conhecido.",
      },
      {
        sourceName: "Fonte jornalística",
        sourceUrl: "https://example.net/news",
        sourceType: "journalistic",
        confirmedClaims: [],
        unconfirmedClaims: [],
        interpretationRisk: "Receção não é prova.",
      },
    ],
    unsupportedClaims: [],
    diagnosisAllowed: true,
    notes: "Notas do gate.",
  };
  const item = {
    title: "Radar item",
    url: "https://example.com/story",
    source: "hn",
    sourceUrl: "https://news.ycombinator.com/item?id=1",
    rank: 1,
    score: 1,
    commentsCount: 1,
    signals: ["ai-tool"],
    scores: { novelty: 1 },
    totalScore: 1,
    whyCollect: "Tem sinal.",
    possibleAngles: ["Um ângulo"],
    strategicQuestions: ["Uma pergunta"],
    rawSignals: [],
  };
  const selected = {
    slug: "security-test",
    publishedOn: "2026-07-25",
    manifest: {
      status: "ok",
      value: {
        title: "Pacote",
        description: "Descrição",
        slides: [],
      },
    },
    diagnosis: { status: "ok", value: "Diagnóstico." },
    draft: { status: "ok", value: "Draft." },
    sourceGate: { status: "ok", value: gate },
    formats: [{
      id: "blog",
      label: "Blog",
      path: "publication/blog.md",
      markdown: { status: "ok", value: "Formato." },
    }],
    qa: {
      canonical: { status: "ok", value: gate },
      humanNotes: { status: "ok", value: "Sem decisão." },
      html: [evidence("html")],
      factCheck: [],
      lint: [],
    },
    indexHtml: { status: "missing", detail: "Ausente." },
    warnings: [],
  } as unknown as CockpitModel["selectedPackage"];

  return {
    dataRoot: "configured",
    selectedSlug: "security-test",
    selectedPackage: selected!,
    packages: [{ slug: "security-test", title: "Pacote", publishedOn: "2026-07-25", status: "ok" }],
    radar: {
      status: "ok",
      value: { generatedAt: "2026-07-25T10:00:00.000Z", itemCount: 1, items: [item], global: true },
      runAt: "2026-07-25T10:00:00.000Z",
    },
    warnings: [],
    freshness: "25/07/2026",
    readOnly: true,
  } as unknown as CockpitModel;
}
