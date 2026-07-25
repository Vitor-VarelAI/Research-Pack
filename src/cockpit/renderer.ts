import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Publication } from "../schemas/publication.js";
import type { SourceGateResult } from "../schemas/source-gate.js";
import type { Artifact, CockpitModel, CockpitPackage, MarkdownArtifact, QaEvidence } from "./types.js";

const MARKDOWN_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong", "ul",
];
const NAV_ITEMS = [
  ["radar", "Radar"],
  ["fontes", "Fontes"],
  ["diagnostico", "Diagnóstico"],
  ["draft", "Draft"],
  ["formatos", "Formatos"],
  ["qa", "QA"],
] as const;
const SENSITIVE_KEY_NAMES = new Set([
  "credential", "credentials", "secret", "secrets", "token", "tokens", "apikey", "apikeys", "accesstoken", "accesstokens", "refreshtoken", "refreshtokens", "authorization", "auth", "bearer", "password", "passwd", "cookie", "cookies", "session", "sessions", "privatekey", "privatekeys",
  "key", "signature", "sig", "expires",
  "id", "ids", "runid", "runids", "internalid", "internalids", "internalrunid", "internalrunids", "executionid", "executionids", "correlationid", "correlationids", "requestid", "requestids", "documentid", "documentids", "docid", "docids", "jobid", "jobids", "taskid", "taskids", "traceid", "traceids", "spanid", "spanids", "operationid", "operationids", "identifier", "identifiers",
]);
const INTERNAL_TOKEN_PATTERN = /\b(?:run|doc|document)_[a-z0-9][a-z0-9_-]*\b/iu;
const SCORE_LABELS: Record<string, string> = {
  novelty: "Novidade",
  visualStrength: "Força visual",
  practicalUtility: "Utilidade",
  domainFit: "Fit editorial",
  opinionPotential: "Potencial de opinião",
  verificationNeed: "Necessidade de verificação",
  timingStrategy: "Timing estratégico",
  distributionLeverage: "Alavanca de distribuição",
  moneyIncentive: "Incentivo financeiro",
};

export function renderMarkdownSafe(markdown: string): string {
  const prepared = prepareMarkdown(markdown);
  try {
    const raw = marked.parse(prepared, { async: false }) as string;
    return sanitizeHtml(raw, {
      allowedTags: MARKDOWN_TAGS,
      allowedAttributes: { a: ["href", "title", "target", "rel"] },
      allowedSchemes: ["http", "https", "mailto"],
      allowedSchemesByTag: { a: ["http", "https", "mailto"] },
      allowProtocolRelative: false,
      disallowedTagsMode: "discard",
      transformTags: {
        a: (_tagName, attributes) => {
          const href = safeExternalUrl(attributes.href);
          return {
            tagName: "a",
            attribs: {
              ...(href ? { href } : {}),
              ...(attributes.title ? { title: stripUnsafeText(attributes.title) } : {}),
              target: "_blank",
              rel: "noreferrer noopener",
            },
          };
        },
      },
    });
  } catch {
    return `<p>${escapeHtml(stripUnsafeText(prepared.slice(0, 100_000)))}</p>`;
  }
}

export function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") return undefined;
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const values = parsed.searchParams.getAll(key);
      if (isSensitiveKey(key) || INTERNAL_TOKEN_PATTERN.test(key) || values.some((entry) => INTERNAL_TOKEN_PATTERN.test(entry)) || /^(?:utm_|fbclid|gclid|mc_cid|mc_eid|sig(?:nature)?|expires|x-amz-)/iu.test(key)) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname.replace(/\b(?:run|doc|document)_[a-z0-9][a-z0-9_-]*\b/giu, "[identifier-omitted]");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function renderCockpitHtml(model: CockpitModel): string {
  const selected = model.selectedPackage;
  const title = selected?.manifest.value?.title ?? "Cockpit editorial";
  const description = selected?.manifest.value?.description ?? "Leitura operacional dos artefactos editoriais, sem execução do pipeline.";
  const allWarnings = [...new Set([...model.warnings, ...(selected?.warnings ?? [])])];
  const nav = NAV_ITEMS.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("");
  const packageOptions = model.packages.length > 0
    ? model.packages.map((item) => `<option value="${escapeHtml(item.slug)}"${item.slug === model.selectedSlug ? " selected" : ""}>${escapeHtml(item.title)}${item.publishedOn ? ` · ${escapeHtml(formatDate(item.publishedOn))}` : ""}</option>`).join("")
    : `<option value="">Nenhum pacote disponível</option>`;

  return `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)} · Cockpit</title>
  <style>${styles()}</style>
</head>
<body>
  <header class="mobile-header">
    <a class="wordmark" href="#radar" aria-label="Cockpit editorial, ir para Radar">VV / cockpit</a>
    <span class="read-only">Somente leitura</span>
  </header>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Navegação principal">
      <div class="brand-block">
        <a class="wordmark" href="#radar" aria-label="Cockpit editorial, ir para Radar">VV / cockpit</a>
        <p>mesa editorial</p>
      </div>
      <nav class="section-nav" aria-label="Áreas do cockpit">${nav}</nav>
      <div class="sidebar-foot">
        <span class="status-dot" aria-hidden="true"></span>
        <span>Leitura local</span>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="topbar-copy">
          <p class="kicker">Operações editoriais / artefactos</p>
          <h1>${escapeHtml(title)}</h1>
          <p class="lede">${escapeHtml(description)}</p>
        </div>
        <div class="topbar-controls">
          <label for="package-select">Pacote</label>
          <select id="package-select" name="package" aria-label="Selecionar pacote editorial">${packageOptions}</select>
          <span class="freshness"><span class="status-dot" aria-hidden="true"></span>${model.freshness ? `Atualizado ${escapeHtml(model.freshness)}` : "Sem data de atualização"}</span>
          <span class="read-only">Somente leitura</span>
        </div>
      </header>
      ${allWarnings.length > 0 ? renderWarnings(allWarnings) : ""}
      ${renderSummary(model, selected)}
      <main>
        <section id="radar" class="section" aria-labelledby="radar-title">
          <div class="section-heading"><div><p class="kicker">01 / sinal</p><h2 id="radar-title">Radar</h2></div><p class="section-note">A última corrida <strong>radar-hn válida</strong>, global. Não existe ligação entre uma corrida e este pacote.</p></div>
          ${renderRadar(model)}
        </section>
        <section id="fontes" class="section" aria-labelledby="fontes-title">
          <div class="section-heading"><div><p class="kicker">02 / evidência</p><h2 id="fontes-title">Fontes</h2></div><p class="section-note">O source gate é a referência canónica de suficiência. As interpretações continuam visíveis por âncora.</p></div>
          ${renderSources(selected)}
        </section>
        <section id="diagnostico" class="section" aria-labelledby="diagnostico-title">
          <div class="section-heading"><div><p class="kicker">03 / leitura</p><h2 id="diagnostico-title">Diagnóstico</h2></div><p class="section-note">Markdown renderizado localmente e sanitizado antes de chegar ao browser.</p></div>
          ${renderMarkdownArtifact(selected?.diagnosis, "O diagnóstico não está disponível.")}
        </section>
        <section id="draft" class="section" aria-labelledby="draft-title">
          <div class="section-heading"><div><p class="kicker">04 / copy</p><h2 id="draft-title">Draft</h2></div><p class="section-note">Texto longo para leitura e revisão, sem executar o HTML publicado.</p></div>
          ${renderMarkdownArtifact(selected?.draft, "O draft não está disponível.", "longform")}
        </section>
        <section id="formatos" class="section" aria-labelledby="formatos-title">
          <div class="section-heading"><div><p class="kicker">05 / distribuição</p><h2 id="formatos-title">Formatos</h2></div><p class="section-note">Sete saídas manifest-driven e um resumo da apresentação. O index.html existente não é executado aqui.</p></div>
          ${renderFormats(selected)}
        </section>
        <section id="qa" class="section" aria-labelledby="qa-title">
          <div class="section-heading"><div><p class="kicker">06 / controlo</p><h2 id="qa-title">QA</h2></div><p class="section-note">Decisão canónica, notas humanas e verificadores aparecem separados para não esconder desacordos.</p></div>
          ${renderQa(selected)}
        </section>
      </main>
      <footer class="footer"><span>Read model local · sem escrita de dados</span><span>PT-PT · seis áreas operacionais</span></footer>
    </div>
  </div>
  <script>${clientScript()}</script>
</body>
</html>`;
}

function renderSummary(model: CockpitModel, selected: CockpitPackage | undefined): string {
  const sourceCount = selected?.sourceGate.value?.anchors.length ?? 0;
  const formatCount = selected?.formats.length ?? 0;
  const radarCount = model.radar.value?.itemCount ?? 0;
  const qaCount = selected ? selected.qa.html.length + selected.qa.factCheck.length + selected.qa.lint.length : 0;
  return `<section class="summary" aria-label="Resumo operacional">
    <article class="summary-card summary-card--accent"><span class="summary-label">Pacote activo</span><strong>${escapeHtml(selected?.slug ?? "Sem seleção")}</strong><span>${selected?.manifest.status === "ok" ? "manifesto válido" : "manifesto com problemas"}</span></article>
    <article class="summary-card"><span class="summary-label">Radar global</span><strong>${radarCount}</strong><span>${model.radar.status === "ok" ? "histórias com sinal" : "sem corrida válida"}</span></article>
    <article class="summary-card"><span class="summary-label">Âncoras</span><strong>${sourceCount}</strong><span>fontes no source gate</span></article>
    <article class="summary-card"><span class="summary-label">Saídas</span><strong>${formatCount}/7</strong><span>${qaCount} evidências QA carregadas</span></article>
  </section>`;
}

function renderWarnings(warnings: string[]): string {
  return `<aside class="warnings" aria-label="Avisos de integridade"><div class="warning-icon" aria-hidden="true">!</div><div><strong>Há artefactos a confirmar</strong><ul>${warnings.slice(0, 12).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>${warnings.length > 12 ? `<p>+ ${warnings.length - 12} avisos adicionais.</p>` : ""}</div></aside>`;
}

function renderRadar(model: CockpitModel): string {
  const limitedNotice = model.radar.truncated ? `<span class="radar-limited">Leitura limitada à cauda do ficheiro</span>` : "";
  if (model.radar.status !== "ok" || !model.radar.value) return `${renderEmpty(model.radar.detail ?? "O radar não está disponível.")}${limitedNotice ? `<p class="radar-limited-note">${limitedNotice}</p>` : ""}`;
  const items = model.radar.value.items.map((item, index) => {
    const scoreEntries = Object.entries(item.scores).map(([key, value]) => `<span class="score-line"><span>${escapeHtml(SCORE_LABELS[key] ?? key)}</span><b>${value}/5</b><i><em style="width:${value * 20}%"></em></i></span>`).join("");
    return `<article class="radar-item"><div class="rank">${String(item.rank ?? index + 1).padStart(2, "0")}</div><div class="radar-main"><div class="item-meta"><span>${escapeHtml(item.source.toUpperCase())}</span><span>${item.commentsCount ?? 0} comentários</span><span>total ${item.totalScore}</span></div><h3>${escapeHtml(item.title)}</h3><a class="safe-url" href="${escapeHtml(safeExternalUrl(item.url) ?? "#")}" target="_blank" rel="noreferrer noopener">${escapeHtml(displayUrl(item.url))}</a><p>${escapeHtml(item.whyCollect)}</p><div class="chips">${item.signals.map((signal) => `<span class="chip">${escapeHtml(signal)}</span>`).join("")}</div><details><summary>Dimensões e ângulos</summary><div class="score-grid">${scoreEntries}</div><div class="detail-columns"><div><h4>Ângulos possíveis</h4><ul>${item.possibleAngles.map((angle) => `<li>${escapeHtml(angle)}</li>`).join("")}</ul></div><div><h4>Perguntas estratégicas</h4><ul>${item.strategicQuestions.slice(0, 3).map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul></div></div></details></div><div class="radar-score"><span>score</span><strong>${item.totalScore}</strong></div></article>`;
  }).join("");
  return `<div class="radar-context"><span class="live-marker"></span><strong>Global</strong><span>radar-hn · ${escapeHtml(formatDate(model.radar.runAt ?? model.radar.value.generatedAt))}</span><span class="muted">${model.radar.value.itemCount} itens</span>${limitedNotice}</div><div class="radar-list">${items}</div>`;
}

function renderSources(selected: CockpitPackage | undefined): string {
  const gate = selected?.sourceGate.value;
  if (!gate) return renderArtifactNotice(selected?.sourceGate, "O source-gate.json não está disponível ou é inválido.");
  const confirmed = gate.anchors.reduce((count, anchor) => count + anchor.confirmedClaims.length, 0);
  const unconfirmed = gate.anchors.reduce((count, anchor) => count + anchor.unconfirmedClaims.length, 0);
  return `<div class="source-overview"><div class="source-status ${gate.pass ? "is-good" : "is-warning"}"><span class="eyebrow">Decisão canónica</span><strong>${gate.pass ? "PASS" : "HOLD"}</strong><p>${gate.diagnosisAllowed ? "Diagnóstico autorizado pelo source gate." : "Diagnóstico não autorizado pelo source gate."}</p></div><div class="metric-card"><span>Âncoras</span><strong>${gate.anchors.length}</strong><small>mínimo ${gate.needsExtraAnchor ? "4" : "3"}</small></div><div class="metric-card"><span>Claims confirmados</span><strong>${confirmed}</strong><small>por todas as âncoras</small></div><div class="metric-card"><span>Claims por confirmar</span><strong>${unconfirmed}</strong><small>mantidos visíveis</small></div></div><div class="source-layout"><div class="source-anchors"><h3>Âncoras canónicas</h3>${gate.anchors.map((anchor, index) => `<article class="source-card"><div class="source-number">${String(index + 1).padStart(2, "0")}</div><div><div class="item-meta"><span>${escapeHtml(anchor.sourceType)}</span><span>${anchor.confirmedClaims.length} confirmados</span><span>${anchor.unconfirmedClaims.length} por confirmar</span></div><h3>${escapeHtml(anchor.sourceName)}</h3><a class="safe-url" href="${escapeHtml(safeExternalUrl(anchor.sourceUrl) ?? "#")}" target="_blank" rel="noreferrer noopener">${escapeHtml(displayUrl(anchor.sourceUrl))}</a><p class="risk"><strong>Risco de interpretação:</strong> ${escapeHtml(anchor.interpretationRisk)}</p><details><summary>Claims</summary><div class="claim-columns"><div><h4>Confirmados</h4><ul>${anchor.confirmedClaims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join("") || "<li>Nenhum registado.</li>"}</ul></div><div><h4>Não confirmados</h4><ul>${anchor.unconfirmedClaims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join("") || "<li>Nenhum registado.</li>"}</ul></div></div></details></div></article>`).join("")}</div><aside class="source-side"><div class="side-card"><h3>Categorias sensíveis</h3><div class="chips">${gate.sensitiveCategories.map((category) => `<span class="chip chip--warm">${escapeHtml(category)}</span>`).join("") || "<span class=\"muted\">Nenhuma registada.</span>"}</div><p>${escapeHtml(gate.notes || "Sem notas adicionais.")}</p></div><div class="side-card"><h3>Claims não suportados</h3>${gate.unsupportedClaims.map((claim) => `<div class="unsupported"><strong>${escapeHtml(claim.claim)}</strong><p>${escapeHtml(claim.whyUnsupported)}</p><span>${escapeHtml(claim.suggestedSourceType)}</span></div>`).join("") || "<p class=\"muted\">Nenhum claim não suportado registado.</p>"}</div></aside></div>`;
}

function renderMarkdownArtifact(artifact: MarkdownArtifact | undefined, empty: string, className = "") {
  if (!artifact || artifact.status !== "ok" || artifact.value === undefined) return renderArtifactNotice(artifact, empty);
  return `<article class="markdown-card ${className}"><div class="prose">${renderMarkdownSafe(artifact.value)}</div></article>`;
}

function renderFormats(selected: CockpitPackage | undefined): string {
  if (!selected) return renderEmpty("Selecione um pacote para ver os formatos.");
  const publication = selected.manifest.value;
  const tabs = selected.formats.map((format, index) => `<button class="format-tab" type="button" role="tab" tabindex="${index === 0 ? "0" : "-1"}" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="format-panel-${escapeHtml(format.id)}" id="format-tab-${escapeHtml(format.id)}" data-format-id="${escapeHtml(format.id)}">${escapeHtml(format.label)}</button>`).join("");
  const panels = selected.formats.map((format, index) => `<article class="format-panel ${index === 0 ? "is-active" : ""}" role="tabpanel" aria-hidden="${index === 0 ? "false" : "true"}" id="format-panel-${escapeHtml(format.id)}" aria-labelledby="format-tab-${escapeHtml(format.id)}" data-format-panel="${escapeHtml(format.id)}">${format.markdown.status === "ok" && format.markdown.value !== undefined ? `<div class="format-meta"><span>Manifesto · ${escapeHtml(format.label)}</span><span>disponível</span></div><div class="prose">${renderMarkdownSafe(format.markdown.value)}</div>` : renderArtifactNotice(format.markdown, `O formato ${format.label} não está disponível.`)}</article>`).join("");
  const slides = publication ? publication.slides.map((slide, index) => `<li><span class="slide-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(slide.eyebrow)}</strong>${escapeHtml(slide.title)}</span>${slide.stat ? `<b>${escapeHtml(String(slide.stat.value))}</b>` : ""}</li>`).join("") : "";
  const previewNote = selected.indexHtml.status === "ok"
    ? "A apresentação index.html foi detetada, mas não é executada para manter a fronteira de leitura segura."
    : "O index.html não está disponível; a apresentação não é executada neste cockpit.";
  return `<div class="formats-grid"><div><div class="tabs" role="tablist" aria-label="Sete formatos de publicação">${tabs}</div><div class="format-panels">${panels}</div></div><aside class="slides-card"><div class="item-meta"><span>Resumo da apresentação</span><span>${publication?.slides.length ?? 0} slides</span></div><h3>${escapeHtml(publication?.title ?? "Sem manifesto")}</h3><ol>${slides || "<li>Resumo indisponível.</li>"}</ol><p class="muted">${previewNote}</p></aside></div>`;
}

function renderQa(selected: CockpitPackage | undefined): string {
  if (!selected) return renderEmpty("Selecione um pacote para ver QA.");
  const canonical = selected.qa.canonical.value;
  const canonicalVerdict = canonical ? (canonical.pass ? "PASS" : "HOLD") : undefined;
  const humanVerdict = selected.qa.humanNotes.status === "ok" && selected.qa.humanNotes.value !== undefined
    ? humanDecision(selected.qa.humanNotes.value)
    : undefined;
  const workerEvidence = [...selected.qa.html, ...selected.qa.factCheck, ...selected.qa.lint];
  const workerVerdicts = workerEvidence
    .map((item) => item.artifact.status === "ok" ? evidenceDecision(item.artifact.value) : undefined)
    .filter((value): value is string => value !== undefined && value !== "carregado" && value !== "sem erros");
  const signals = [canonicalVerdict, humanVerdict, ...workerVerdicts].filter((value): value is string => value !== undefined);
  const disagreement = new Set(signals).size > 1;
  const signalSummary = [
    canonicalVerdict ? `canónico: ${canonicalVerdict}` : "canónico: indisponível",
    humanVerdict ? `humano: ${humanVerdict}` : "humano: sem decisão explícita",
    workerVerdicts.length > 0 ? `workers: ${[...new Set(workerVerdicts)].join(", ")}` : "workers: sem veredicto explícito",
  ].join(" · ");
  const canonicalBlock = canonical ? `<article class="qa-canonical"><div><span class="eyebrow">Source gate / decisão canónica</span><strong class="qa-decision ${canonical.pass ? "is-good" : "is-warning"}">${canonicalVerdict}</strong><p>${canonical.diagnosisAllowed ? "O diagnóstico está autorizado." : "O diagnóstico está bloqueado."}</p></div><dl><div><dt>Âncoras</dt><dd>${canonical.anchors.length}</dd></div><div><dt>Sensíveis</dt><dd>${canonical.sensitiveCategories.length}</dd></div><div><dt>Claims sem suporte</dt><dd>${canonical.unsupportedClaims.length}</dd></div></dl></article>` : renderArtifactNotice(selected.qa.canonical, "A decisão canónica não está disponível.");
  const reconciliation = `<article class="qa-reconciliation ${disagreement ? "is-conflict" : ""}"><div><span class="eyebrow">Leitura combinada</span><strong>${disagreement ? "DESACORDO" : signals.length > 0 ? "EVIDÊNCIA ALINHADA" : "SEM DECISÃO"}</strong><p>${escapeHtml(signalSummary)}</p></div></article>`;
  const humanLabel = humanVerdict ? `humano · ${humanVerdict}` : "qa-notes";
  return `<div class="qa-stack">${canonicalBlock}${reconciliation}<div class="qa-grid"><article class="qa-card"><div class="card-heading"><h3>Notas humanas</h3><span>${escapeHtml(humanLabel)}</span></div>${selected.qa.humanNotes.status === "ok" && selected.qa.humanNotes.value !== undefined ? `<div class="prose prose--compact">${renderMarkdownSafe(selected.qa.humanNotes.value)}</div>` : `<p class="muted">${escapeHtml(selected.qa.humanNotes.detail ?? "Não disponível.")}</p>`}</article><article class="qa-card"><div class="card-heading"><h3>HTML QA</h3><span>${selected.qa.html.length} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.html)}</article><article class="qa-card"><div class="card-heading"><h3>Fact-check</h3><span>${selected.qa.factCheck.length} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.factCheck)}</article><article class="qa-card"><div class="card-heading"><h3>Lint editorial e formatos</h3><span>${selected.qa.lint.length} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.lint)}</article></div></div>`;
}

function renderEvidenceList(items: QaEvidence[]): string {
  if (items.length === 0) return `<p class="muted">Nenhuma evidência disponível.</p>`;
  return `<div class="evidence-list">${items.map((item) => `<details class="evidence"><summary><span>${escapeHtml(item.provider)}</span><span class="evidence-kind">${escapeHtml(item.kind)}</span><span>${item.final ? "final" : "não final"}</span><b class="evidence-status ${item.artifact.status === "ok" ? "is-good" : "is-warning"}">${item.artifact.status === "ok" ? evidenceDecision(item.artifact.value) : "indisponível"}</b></summary>${item.artifact.status === "ok" ? `<pre>${escapeHtml(formatEvidence(item.artifact.value))}</pre>` : `<p class="muted">${escapeHtml(item.artifact.detail ?? "Artefacto inválido.")}</p>`}</details>`).join("")}</div>`;
}

export function evidenceDecision(value: unknown): string {
  if (isRecord(value)) {
    if (typeof value.model_verdict === "string") return normaliseVerdict(value.model_verdict);
    if (typeof value.pass === "boolean") return value.pass ? "PASS" : "HOLD";
    if (isRecord(value.presentation) && Array.isArray(value.presentation.consoleErrors) && value.presentation.consoleErrors.length === 0) return "sem erros";
  }
  return "carregado";
}

function humanDecision(value: string): string | undefined {
  const explicit = value.match(/(?:decis(?:ão|ion)|verdict|status|resultado)\s*[:=-]\s*([a-záéíóú_-]+)/iu)?.[1];
  if (!explicit) return undefined;
  const verdict = normaliseVerdict(explicit);
  return verdict === "carregado" ? undefined : verdict;
}

function normaliseVerdict(value: string): string {
  const normalised = value.trim().toLowerCase();
  if (/pass|aprov|approved|sucesso|ok/iu.test(normalised)) return "PASS";
  if (/hold|fail|block|rejeit|failed|erro/iu.test(normalised)) return "HOLD";
  if (/review|revis|needs[_ -]?review|manual/iu.test(normalised)) return "REVIEW";
  return redactSecrets(stripUnsafeText(value)).replace(/[_-]+/gu, " ").trim().slice(0, 48) || "carregado";
}

function formatEvidence(value: unknown): string {
  return JSON.stringify(scrubForDisplay(value), null, 2) ?? "Sem conteúdo.";
}

export function scrubForDisplay(value: unknown, key = ""): unknown {
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (isSensitiveKey(entryKey) || INTERNAL_TOKEN_PATTERN.test(entryKey) || /^(?:path|filePath|filename)$/iu.test(entryKey)) continue;
      output[entryKey] = scrubForDisplay(entryValue, entryKey);
    }
    return output;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubForDisplay(entry, key));
  if (typeof value !== "string") return value;
  if (/url|uri|href|link/iu.test(key)) return safeExternalUrl(value) ?? "[URL omitido]";
  return redactSecrets(stripUnsafeText(value));
}

function isSensitiveKey(key: string): boolean {
  const compact = key.replace(/[\s_-]/gu, "").toLowerCase();
  return SENSITIVE_KEY_NAMES.has(compact);
}

function renderArtifactNotice(artifact: Artifact<unknown> | undefined, fallback: string): string {
  return `<div class="artifact-notice"><span class="notice-symbol">!</span><div><strong>${escapeHtml(fallback)}</strong><p>${escapeHtml(artifact?.detail ?? "O read model não encontrou este artefacto.")}</p></div></div>`;
}

function renderEmpty(message: string): string {
  return `<div class="empty-state"><span>—</span><p>${escapeHtml(message)}</p></div>`;
}

function displayUrl(value: string): string {
  try {
    const safe = safeExternalUrl(value);
    if (!safe) return "URL não disponível";
    const parsed = new URL(safe);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`.replace(/\/$/u, "") || parsed.hostname;
  } catch {
    return "URL não disponível";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "data inválida";
  return new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}

function escapeHtml(value: string): string {
  return redactSecrets(stripUnsafeText(value)).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function prepareMarkdown(markdown: string): string {
  return redactSecrets(markdown)
    .replace(/<[^>]*>/gu, "")
    .replace(/javascript\s*:/giu, "")
    .replace(/data\s*:/giu, "")
    .replace(/https?:\/\/[^\s<>"']+/giu, (value) => safeExternalUrl(value.replace(/[),.;]+$/gu, "")) ?? "");
}

function redactSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => safeExternalUrl(candidate.replace(/[),.;]+$/gu, "")) ?? "[URL omitido]")
    .replace(/\b(?:run|doc|document)_[a-z0-9][a-z0-9_-]*\b/giu, "[identificador omitido]")
    .replace(/(?:api[_ -]?key|access[_ -]?token|secret|authorization|bearer|password|passwd|cookie|session|private[_ -]?key|auth)\s*[:=]\s*[^\s,;]+/giu, "[conteúdo omitido]")
    .replace(/\b(?:sk|fc)-[a-z0-9][a-z0-9_-]{8,}\b/giu, "[conteúdo omitido]")
    .replace(/(?:\/home\/|\/tmp\/|[A-Z]:\\)[^\s<>"']*/gu, "[caminho omitido]");
}

function stripUnsafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientScript(): string {
  return `(() => {
  const select = document.getElementById('package-select');
  select?.addEventListener('change', () => {
    const value = select.value;
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('package', value); else url.searchParams.delete('package');
    window.location.assign(url.pathname + url.search + window.location.hash);
  });
  const tabs = Array.from(document.querySelectorAll('[data-format-id]'));
  const activateTab = (tab) => {
    const id = tab.getAttribute('data-format-id');
    if (!id) return;
    tabs.forEach((candidate) => {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.setAttribute('tabindex', selected ? '0' : '-1');
    });
    document.querySelectorAll('[data-format-panel]').forEach((panel) => {
      const active = panel.getAttribute('data-format-panel') === id;
      panel.classList.toggle('is-active', active);
      panel.setAttribute('aria-hidden', String(!active));
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next]);
    });
  });
})();`;
}

function styles(): string {
  return `
:root { color-scheme: light; --ink:#162026; --ink-soft:#415057; --paper:#f4f4f0; --card:#fff; --line:#d7dcd9; --line-strong:#b8c1bd; --teal:#14766b; --teal-soft:#dcefe9; --amber:#a55b18; --amber-soft:#fff0dc; --red:#a83735; --shadow:0 10px 30px rgba(21,35,35,.06); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; color:var(--ink); background:var(--paper); overflow-x:hidden; }
a { color:inherit; }
button, select, a { font:inherit; }
button, select { min-height:44px; }
:focus-visible { outline:3px solid #d06436; outline-offset:3px; }
.mobile-header { display:none; }
.app-shell { display:grid; grid-template-columns:208px minmax(0,1fr); min-height:100vh; }
.sidebar { position:sticky; top:0; display:flex; flex-direction:column; height:100vh; padding:25px 18px 20px; border-right:1px solid var(--line); background:#ebece7; }
.wordmark { display:inline-flex; min-height:44px; align-items:center; text-decoration:none; font-size:.86rem; font-weight:850; letter-spacing:-.03em; }
.brand-block p { margin:7px 0 0; color:var(--ink-soft); font-size:.66rem; letter-spacing:.15em; text-transform:uppercase; }
.section-nav { display:grid; gap:4px; margin-top:62px; }
.section-nav a { display:flex; align-items:center; min-height:44px; padding:0 10px; border-left:2px solid transparent; color:var(--ink-soft); font-size:.8rem; font-weight:700; text-decoration:none; }
.section-nav a:hover { color:var(--ink); background:rgba(255,255,255,.56); }
.section-nav a:active, .tabs button:active { transform:scale(.98); }
.sidebar-foot { display:flex; align-items:center; gap:8px; margin-top:auto; color:var(--ink-soft); font-size:.7rem; }
.status-dot, .live-marker { display:inline-block; width:8px; height:8px; flex:0 0 auto; border-radius:50%; background:var(--teal); }
.workspace { min-width:0; }
.topbar { display:flex; justify-content:space-between; gap:40px; padding:42px clamp(24px,5vw,76px) 30px; border-bottom:1px solid var(--line); }
.topbar-copy { min-width:0; }
.kicker, .summary-label, .eyebrow { margin:0; color:var(--teal); font-size:.66rem; font-weight:850; letter-spacing:.13em; line-height:1.2; text-transform:uppercase; }
h1, h2, h3, h4, p { overflow-wrap:anywhere; }
h1 { max-width:760px; margin:12px 0 10px; font-size:clamp(2rem,4.8vw,4.5rem); letter-spacing:-.07em; line-height:.95; }
h2 { margin:6px 0 0; font-size:clamp(1.8rem,3vw,3rem); letter-spacing:-.06em; line-height:1; }
h3 { margin:0; font-size:1.08rem; letter-spacing:-.025em; line-height:1.2; }
h4 { margin:0 0 8px; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; }
.lede { max-width:720px; margin:0; color:var(--ink-soft); font-size:.98rem; line-height:1.5; }
.topbar-controls { display:flex; flex:0 0 240px; flex-direction:column; align-items:stretch; gap:8px; align-self:start; }
.topbar-controls label { color:var(--ink-soft); font-size:.67rem; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
select { width:100%; padding:0 34px 0 12px; border:1px solid var(--line-strong); border-radius:5px; background:var(--card); color:var(--ink); font-weight:750; }
.read-only, .freshness { display:inline-flex; align-items:center; gap:7px; color:var(--ink-soft); font-size:.68rem; font-weight:700; }
.freshness { margin-top:5px; }
.summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; padding:24px clamp(24px,5vw,76px); border-bottom:1px solid var(--line); }
.summary-card { display:flex; min-height:112px; flex-direction:column; justify-content:space-between; padding:15px 16px; border:1px solid var(--line); border-radius:7px; background:var(--card); box-shadow:var(--shadow); }
.summary-card--accent { border-top:3px solid var(--teal); }
.summary-card strong { max-width:100%; overflow:hidden; font-size:1.23rem; letter-spacing:-.04em; text-overflow:ellipsis; white-space:nowrap; }
.summary-card span:last-child { color:var(--ink-soft); font-size:.74rem; }
.warnings { display:flex; gap:13px; margin:22px clamp(24px,5vw,76px) 0; padding:15px 17px; border:1px solid #e6c596; border-radius:7px; background:var(--amber-soft); color:#633c18; }
.warning-icon, .notice-symbol { display:grid; width:23px; height:23px; flex:0 0 auto; place-items:center; border-radius:50%; background:var(--amber); color:#fff; font-weight:850; }
.warnings strong { font-size:.8rem; }
.warnings ul { margin:7px 0 0; padding-left:18px; font-size:.76rem; line-height:1.5; }
.warnings p { margin:5px 0 0; font-size:.74rem; }
.section { scroll-margin-top:18px; padding:56px clamp(24px,5vw,76px) 0; }
.section:last-of-type { padding-bottom:30px; }
.section-heading { display:flex; justify-content:space-between; align-items:end; gap:32px; margin-bottom:22px; }
.section-note { max-width:430px; margin:0; color:var(--ink-soft); font-size:.78rem; line-height:1.5; }
.section-note strong { color:var(--ink); }
.radar-context { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px; color:var(--ink-soft); font-size:.72rem; }
.radar-context strong { color:var(--ink); }
.radar-limited { display:inline-flex; min-height:25px; align-items:center; padding:3px 7px; border:1px solid #e6c596; border-radius:999px; background:var(--amber-soft); color:#80501f; font-size:.62rem; font-weight:800; }
.radar-limited-note { margin:10px 0 0; }
.muted { color:var(--ink-soft); }
.radar-list { border-top:1px solid var(--line-strong); }
.radar-item { display:grid; grid-template-columns:36px minmax(0,1fr) 76px; gap:14px; padding:19px 0; border-bottom:1px solid var(--line); }
.rank { color:var(--teal); font-size:.84rem; font-variant-numeric:tabular-nums; font-weight:850; }
.radar-main { min-width:0; }
.item-meta, .format-meta { display:flex; flex-wrap:wrap; gap:9px; margin-bottom:8px; color:var(--ink-soft); font-size:.62rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
.radar-main h3 { font-size:1.16rem; }
.radar-main > p { max-width:800px; margin:8px 0; color:var(--ink-soft); font-size:.81rem; line-height:1.5; }
.safe-url { display:flex; min-height:44px; max-width:100%; align-items:center; margin-top:5px; padding:8px 0; color:var(--teal); font-size:.74rem; line-height:1.35; overflow-wrap:anywhere; text-decoration:underline; text-decoration-color:#a7d1c8; text-underline-offset:3px; }
.safe-url:hover { text-decoration-color:currentColor; }
.chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
.chip { display:inline-flex; min-height:25px; align-items:center; padding:3px 7px; border:1px solid #b9d8d0; border-radius:999px; background:var(--teal-soft); color:#24675f; font-size:.62rem; font-weight:800; }
.chip--warm { border-color:#e6c596; background:var(--amber-soft); color:#80501f; }
details { margin-top:12px; }
summary { display:flex; min-height:44px; align-items:center; cursor:pointer; color:var(--ink-soft); font-size:.72rem; font-weight:800; }
summary::marker { color:var(--teal); }
.radar-score { display:flex; flex-direction:column; align-items:flex-end; justify-content:center; color:var(--ink-soft); }
.radar-score span { font-size:.62rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
.radar-score strong { color:var(--ink); font-size:2.3rem; letter-spacing:-.08em; line-height:1; }
.score-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px 18px; max-width:900px; margin:12px 0 17px; }
.score-line { display:grid; grid-template-columns:1fr auto; gap:4px; color:var(--ink-soft); font-size:.68rem; }
.score-line b { color:var(--ink); font-size:.65rem; }
.score-line i { display:block; grid-column:1 / -1; height:4px; overflow:hidden; border-radius:4px; background:#e4e8e5; }
.score-line em { display:block; height:100%; border-radius:4px; background:var(--teal); }
.detail-columns, .claim-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:28px; }
.detail-columns ul, .claim-columns ul { margin:0; padding-left:17px; color:var(--ink-soft); font-size:.76rem; line-height:1.5; }
.source-overview { display:grid; grid-template-columns:1.45fr repeat(3,1fr); gap:10px; margin-bottom:22px; }
.source-status, .metric-card, .side-card, .source-card, .qa-card, .qa-canonical, .slides-card, .markdown-card { border:1px solid var(--line); border-radius:7px; background:var(--card); box-shadow:var(--shadow); }
.source-status { padding:17px; border-left:4px solid var(--teal); }
.source-status.is-warning { border-left-color:var(--amber); }
.source-status strong { display:block; margin-top:8px; font-size:1.8rem; letter-spacing:-.06em; }
.source-status p, .side-card p { margin:7px 0 0; color:var(--ink-soft); font-size:.76rem; line-height:1.5; }
.metric-card { display:flex; min-height:105px; flex-direction:column; justify-content:space-between; padding:15px; }
.metric-card span, .metric-card small { color:var(--ink-soft); font-size:.68rem; }
.metric-card strong { font-size:2rem; letter-spacing:-.08em; }
.source-layout { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(240px,.65fr); gap:18px; }
.source-anchors > h3 { margin:0 0 9px; }
.source-card { display:grid; grid-template-columns:35px minmax(0,1fr); gap:14px; margin-bottom:9px; padding:17px; }
.source-number { color:var(--teal); font-size:.75rem; font-weight:850; }
.source-card .safe-url { margin-bottom:12px; }
.risk { margin:12px 0 0; color:var(--ink-soft); font-size:.76rem; line-height:1.5; }
.risk strong { color:var(--amber); }
.claim-columns { margin-top:12px; }
.claim-columns ul { padding-left:16px; }
.source-side { display:grid; align-content:start; gap:10px; }
.side-card { padding:17px; }
.side-card h3 { margin-bottom:12px; }
.unsupported { padding:11px 0; border-top:1px solid var(--line); }
.unsupported strong { font-size:.78rem; line-height:1.35; }
.unsupported p { margin:6px 0; }
.unsupported span { color:var(--amber); font-size:.67rem; font-weight:800; }
.markdown-card { padding:clamp(20px,4vw,46px); }
.markdown-card.longform { max-width:920px; }
.prose { max-width:740px; color:#28343a; font-family:Georgia, "Times New Roman", serif; font-size:1.04rem; line-height:1.72; }
.prose--compact { font-family:inherit; font-size:.8rem; line-height:1.55; }
.prose > :first-child { margin-top:0; }
.prose > :last-child { margin-bottom:0; }
.prose h1, .prose h2, .prose h3, .prose h4 { color:var(--ink); font-family:inherit; line-height:1.15; }
.prose h1 { font-size:2rem; }
.prose h2 { margin-top:2.3em; font-size:1.5rem; }
.prose h3 { margin-top:1.9em; font-size:1.18rem; }
.prose p { margin:0 0 1.15em; }
.prose a { color:var(--teal); text-underline-offset:3px; overflow-wrap:anywhere; }
.prose blockquote { margin:1.3em 0; padding-left:16px; border-left:3px solid #91c8bc; color:var(--ink-soft); }
.prose code { padding:2px 4px; border-radius:3px; background:#edf0ec; font-family:"SFMono-Regular", Consolas, monospace; font-size:.84em; }
.prose pre { max-width:100%; overflow:auto; padding:14px; border-radius:5px; background:#edf0ec; font-family:"SFMono-Regular", Consolas, monospace; font-size:.78rem; line-height:1.5; }
.prose li { margin:.35em 0; }
.formats-grid { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(240px,.55fr); gap:18px; align-items:start; }
.tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
.tabs button { min-height:44px; padding:0 12px; border:1px solid var(--line-strong); border-radius:5px; background:transparent; color:var(--ink-soft); cursor:pointer; font-size:.72rem; font-weight:800; }
.tabs button[aria-selected="true"] { border-color:var(--ink); background:var(--ink); color:var(--paper); }
.format-panel { display:none; min-height:200px; padding:22px; border:1px solid var(--line); border-radius:7px; background:var(--card); box-shadow:var(--shadow); }
.format-panel.is-active { display:block; }
.format-meta { justify-content:space-between; }
.slides-card { padding:18px; }
.slides-card > h3 { margin:12px 0 17px; font-size:1.4rem; }
.slides-card ol { display:grid; gap:0; margin:0; padding:0; list-style:none; }
.slides-card li { display:grid; grid-template-columns:28px minmax(0,1fr) auto; gap:9px; align-items:start; padding:10px 0; border-top:1px solid var(--line); color:var(--ink-soft); font-size:.76rem; line-height:1.35; }
.slides-card li strong { display:block; margin-bottom:2px; color:var(--teal); font-size:.59rem; letter-spacing:.07em; text-transform:uppercase; }
.slides-card li b { color:var(--ink); font-size:.77rem; }
.slide-index { color:var(--teal); font-size:.65rem; font-weight:850; }
.slides-card p { margin:16px 0 0; font-size:.7rem; line-height:1.45; }
.qa-stack { display:grid; gap:12px; }
.qa-canonical, .qa-reconciliation { display:flex; justify-content:space-between; gap:20px; padding:19px; border:1px solid var(--line); border-radius:7px; background:var(--card); box-shadow:var(--shadow); }
.qa-canonical { border-left:4px solid var(--teal); }
.qa-reconciliation { border-left:4px solid var(--teal); }
.qa-reconciliation.is-conflict { border-left-color:var(--amber); background:var(--amber-soft); }
.qa-reconciliation strong { display:block; margin-top:8px; font-size:1.25rem; letter-spacing:-.04em; }
.qa-reconciliation p { margin:6px 0 0; color:var(--ink-soft); font-size:.76rem; line-height:1.5; overflow-wrap:anywhere; }
.qa-decision { display:block; margin-top:9px; font-size:1.75rem; letter-spacing:-.06em; }
.qa-decision.is-warning { color:var(--amber); }
.qa-canonical p { margin:5px 0 0; color:var(--ink-soft); font-size:.76rem; }
.qa-canonical dl { display:flex; gap:25px; margin:0; }
.qa-canonical dl div { min-width:72px; }
.evidence-kind { text-transform:lowercase; }
.qa-canonical dt { color:var(--ink-soft); font-size:.63rem; font-weight:800; text-transform:uppercase; }
.qa-canonical dd { margin:7px 0 0; font-size:1.6rem; font-weight:800; letter-spacing:-.07em; }
.qa-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.qa-card { min-width:0; padding:17px; }
.card-heading { display:flex; justify-content:space-between; gap:12px; align-items:baseline; margin-bottom:12px; }
.card-heading span { max-width:100%; color:var(--ink-soft); font-size:.62rem; overflow-wrap:anywhere; }
.evidence-list { display:grid; gap:6px; }
.evidence { margin:0; padding:0; border-top:1px solid var(--line); }
.evidence summary { display:grid; grid-template-columns:minmax(0,1fr) auto auto auto; gap:8px; align-items:start; padding:11px 0; color:var(--ink); font-size:.7rem; overflow-wrap:anywhere; }
.evidence summary span:nth-child(2), .evidence-kind { color:var(--ink-soft); font-size:.62rem; }
.evidence-status { color:var(--teal); font-size:.62rem; font-weight:850; text-transform:uppercase; }
.evidence-status.is-warning { color:var(--amber); }
.evidence pre { max-height:330px; margin:0 0 11px; overflow:auto; padding:11px; border-radius:4px; background:#eef0ed; color:#39474c; font-family:"SFMono-Regular", Consolas, monospace; font-size:.68rem; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.artifact-notice, .empty-state { display:flex; gap:12px; align-items:flex-start; padding:18px; border:1px dashed var(--line-strong); border-radius:7px; background:#f9faf7; color:var(--ink-soft); }
.artifact-notice strong { color:var(--ink); font-size:.82rem; }
.artifact-notice p { margin:5px 0 0; font-size:.74rem; }
.empty-state { min-height:105px; align-items:center; }
.empty-state span { color:var(--teal); font-size:1.6rem; }
.empty-state p { margin:0; font-size:.8rem; }
.footer { display:flex; justify-content:space-between; gap:16px; margin:24px clamp(24px,5vw,76px) 0; padding:19px 0 26px; border-top:1px solid var(--line); color:var(--ink-soft); font-size:.65rem; }
@media (hover:none) { .section-nav a:hover, .safe-url:hover { text-decoration:none; background:transparent; } }
@media (max-width:900px) { .app-shell { grid-template-columns:168px minmax(0,1fr); } .topbar { gap:22px; } .topbar-controls { flex-basis:190px; } .source-layout, .formats-grid { grid-template-columns:1fr; } }
@media (max-width:680px) { html { scroll-behavior:auto; } body { min-width:0; } .mobile-header { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; min-height:54px; padding:0 16px; border-bottom:1px solid var(--line); background:rgba(244,244,240,.97); } .sidebar { position:sticky; top:54px; z-index:9; display:block; width:100%; height:auto; padding:0; border-right:0; border-bottom:1px solid var(--line); } .brand-block, .sidebar-foot { display:none; } .app-shell { display:block; } .section-nav { display:flex; gap:3px; margin:0; padding:5px 12px; overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:none; } .section-nav::-webkit-scrollbar { display:none; } .section-nav a { flex:0 0 auto; min-height:44px; padding:0 11px; border-left:0; border-bottom:2px solid transparent; white-space:nowrap; } .section-nav a:hover { background:transparent; } .topbar { display:block; padding:28px 16px 22px; } .topbar-copy h1 { font-size:2.5rem; } .topbar-controls { margin-top:23px; } .summary { grid-template-columns:repeat(2,minmax(0,1fr)); padding:14px 16px; } .summary-card { min-height:96px; padding:12px; } .summary-card strong { font-size:1rem; } .warnings { margin:14px 16px 0; } .section { scroll-margin-top:112px; padding:43px 16px 0; } .section-heading { display:block; margin-bottom:17px; } .section-note { margin-top:12px; } .radar-item { grid-template-columns:27px minmax(0,1fr) 48px; gap:8px; } .radar-score strong { font-size:1.7rem; } .score-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .detail-columns, .claim-columns, .qa-grid, .source-overview { grid-template-columns:1fr; } .source-card { grid-template-columns:27px minmax(0,1fr); padding:14px; } .qa-canonical { display:block; } .qa-canonical dl { margin-top:20px; justify-content:space-between; } .markdown-card { padding:20px 17px; } .prose { font-size:1rem; } .format-panel { padding:17px; } .evidence summary { display:flex; flex-wrap:wrap; gap:6px 10px; } .evidence summary > span:first-child { flex:1 1 100%; } .evidence summary > b { margin-left:auto; } .footer { display:block; margin:24px 16px 0; } .footer span { display:block; margin-top:5px; } }
@media (prefers-reduced-motion:reduce) { *, *::before, *::after { scroll-behavior:auto !important; transition-duration:0.01ms !important; animation-duration:0.01ms !important; } }
`;
}
