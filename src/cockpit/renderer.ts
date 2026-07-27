import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Publication } from "../schemas/publication.js";
import type { SourceGateResult } from "../schemas/source-gate.js";
import type { SafeJob, SafeStage } from "./control-plane.js";
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
type QaVerdict = "PASS" | "HOLD" | "REVIEW";
type QaSignal = QaVerdict | "CONTRADITÓRIO" | "sem decisão" | "sem erros" | "indisponível";

export function renderMarkdownSafe(markdown: string): string {
  const prepared = prepareMarkdown(markdown);
  try {
    const raw = marked.parse(prepared, { async: false }) as string;
    return sanitizeHtml(raw, {
      allowedTags: MARKDOWN_TAGS,
      allowedAttributes: { a: ["href", "title", "target", "rel"] },
      allowedSchemes: ["http", "https"],
      allowedSchemesByTag: { a: ["http", "https"] },
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
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
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

export type CockpitRenderOptions = {
  actionsEnabled?: boolean;
  runnerReady?: boolean;
  csrfToken?: string;
  jobs?: SafeJob[];
  scriptNonce?: string;
};

export function renderCockpitHtml(model: CockpitModel, options: CockpitRenderOptions = {}): string {
  const selected = model.selectedPackage;
  const title = selected?.manifest.value?.title ?? "Cockpit editorial";
  const description = selected?.manifest.value?.description ?? "Leitura operacional dos artefactos editoriais, sem execução do pipeline.";
  const allWarnings = [...new Set([...model.warnings, ...(selected?.warnings ?? [])])];
  const nav = NAV_ITEMS.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("");
  const packageOptions = model.packages.length > 0
    ? model.packages.map((item) => `<option value="${escapeHtml(item.slug)}"${item.slug === model.selectedSlug ? " selected" : ""}>${escapeHtml(item.title)}${item.publishedOn ? ` · ${escapeHtml(formatDate(item.publishedOn))}` : ""}</option>`).join("")
    : `<option value="">Nenhum pacote disponível</option>`;
  const actionsEnabled = options.actionsEnabled === true;
  const runnerReady = options.runnerReady === true;
  const actionsAvailable = actionsEnabled && runnerReady;
  const actionLabel = !actionsEnabled ? "Apenas leitura" : runnerReady ? "Ações disponíveis" : "Configuração necessária";

  return `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(options.csrfToken ?? "")}">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)} · Cockpit</title>
  <style>${styles()}</style>
</head>
<body>
  <header class="mobile-header">
    <a class="wordmark" href="#radar" aria-label="Cockpit editorial, ir para Radar">VV / cockpit</a>
    <span class="read-only action-state" data-action-state>${escapeHtml(actionLabel)}</span>
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
        <span class="action-state" data-action-state>${escapeHtml(actionLabel)}</span>
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
          <span class="read-only action-state" data-action-state>${escapeHtml(actionLabel)}</span>
        </div>
      </header>
      ${allWarnings.length > 0 ? renderWarnings(allWarnings) : ""}
      ${renderControlPlane(options.jobs ?? [], actionsEnabled, runnerReady)}
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
      <footer class="footer"><span>Read model local · ${actionsAvailable ? "ações controladas" : "sem escrita de dados"}</span><span class="action-state" data-action-state>${escapeHtml(actionLabel)}</span><span>PT-PT · seis áreas operacionais</span></footer>
    </div>
  </div>
  <script${options.scriptNonce ? ` nonce="${escapeHtml(options.scriptNonce)}"` : ""}>${clientScript(options.csrfToken ?? "")}</script>
</body>
</html>`;
}

function renderControlPlane(jobs: SafeJob[], actionsEnabled: boolean, runnerReady: boolean): string {
  const active = jobs.find((job) => !["completed", "failed", "cancelled", "interrupted"].includes(job.state));
  const actionsAvailable = actionsEnabled && runnerReady;
  const status = !actionsEnabled ? "Apenas leitura" : runnerReady ? "Ações disponíveis" : "Configuração necessária";
  const recent = jobs.length > 0 ? jobs.slice(0, 4).map((job) => renderJobCard(job, actionsAvailable)).join("") : `<p class="muted">Ainda não existem processos controlados pelo cockpit.</p>`;
  return `<section class="control-plane" id="controlo" data-actions-enabled="${actionsEnabled ? "true" : "false"}" data-runner-ready="${runnerReady ? "true" : "false"}" aria-labelledby="control-plane-title">
    <div class="control-plane-heading"><div><p class="kicker">Control plane / processo editorial</p><h2 id="control-plane-title">Mesa de operação</h2><p class="section-note">Um processo de cada vez, com decisões humanas nos pontos certos.</p></div><div class="control-plane-actions"><span class="control-status ${actionsAvailable ? "is-on" : "is-off"}" id="control-status" role="status"><span class="status-dot" aria-hidden="true"></span>${status}</span><button class="primary-button" id="new-content" type="button"${actionsAvailable && !active ? "" : " disabled"} aria-haspopup="dialog">Novo conteúdo</button></div></div>
    <div class="control-jobs" id="control-jobs" aria-label="Processos recentes">${recent}</div><p class="sr-only" id="control-announcement" role="status" aria-live="polite" aria-atomic="true"></p>
  </section>
  <dialog class="compose-dialog" id="compose-dialog" aria-labelledby="compose-title">
    <form id="compose-form" method="dialog">
      <div class="dialog-head"><div><p class="kicker">Novo processo / 01</p><h2 id="compose-title">Começar conteúdo</h2></div><button class="icon-button" id="compose-close" type="button" aria-label="Fechar">×</button></div>
      <div class="compose-step" id="compose-step-input">
        <fieldset><legend>Partir de</legend><div class="choice-row"><label class="choice-card"><input type="radio" name="source-kind" value="url" checked><span><strong>URL</strong><small>Scrape direto + pesquisa limitada, sem Firecrawl Agent.</small></span></label><label class="choice-card"><input type="radio" name="source-kind" value="topic"><span><strong>Tema</strong><small>Usa Firecrawl Agent e pode consumir créditos após a quota gratuita.</small></span></label></div></fieldset>
        <label class="field-label" for="compose-value" id="compose-value-label">URL</label><input class="text-input" id="compose-value" name="value" type="url" required maxlength="500" inputmode="url" autocomplete="url" placeholder="https://exemplo.pt/artigo">
        <label class="field-label" for="compose-context">Contexto <span>opcional</span></label><textarea class="text-input" id="compose-context" name="context" rows="4" maxlength="4000" placeholder="O que deve orientar a leitura? (opcional)"></textarea>
        <div class="fixed-output"><span class="eyebrow">Saída</span><strong>Blog + formatos</strong><span>Os sete formatos editoriais e dez slides.</span></div><p class="dialog-error" id="compose-error" role="alert" hidden></p>
        <label class="toggle-row"><input type="checkbox" id="compose-html" name="exportHtml"><span><strong>Preparar exportação HTML</strong><small>Opcional; o cockpit continua a abrir o pacote editorial.</small></span></label>
        <div class="dialog-actions"><button class="secondary-button" id="compose-cancel" type="button">Cancelar</button><button class="primary-button" id="compose-next" type="button">Rever resumo</button></div>
      </div>
      <div class="compose-step" id="compose-step-confirm" hidden><p class="kicker">Novo processo / 02</p><h3>Confirma o percurso</h3><dl class="confirmation" id="compose-confirmation"></dl><p class="confirm-note">O processo começa em background e o cockpit acompanha-o por polling.</p><div class="dialog-actions"><button class="secondary-button" id="compose-back" type="button">Voltar</button><button class="primary-button" id="compose-submit" type="submit">Iniciar processo</button></div></div>
    </form>
  </dialog>
  <dialog class="compose-dialog reject-dialog" id="reject-dialog" aria-labelledby="reject-title"><form id="reject-form" method="dialog"><div class="dialog-head"><div><p class="kicker">Revisão final</p><h2 id="reject-title">Rejeitar draft</h2></div><button class="icon-button" id="reject-close" type="button" aria-label="Fechar">×</button></div><label class="field-label" for="reject-note">Nota <span>opcional</span></label><textarea class="text-input" id="reject-note" maxlength="1000" rows="5" placeholder="O que deve ser revisto?"></textarea><p class="dialog-error" id="reject-error" role="alert" hidden></p><div class="dialog-actions"><button class="secondary-button" id="reject-cancel" type="button">Voltar</button><button class="primary-button" id="reject-submit" type="submit">Confirmar rejeição</button></div></form></dialog>`;
}

function renderJobCard(job: SafeJob, actionsEnabled: boolean): string {
  const active = !["completed", "failed", "cancelled", "interrupted"].includes(job.state);
  const stateLabel = stateCopy(job.state);
  return `<article class="job-card ${active ? "is-active" : ""}" data-job-id="${escapeHtml(job.id)}"><div class="job-card-head"><div><span class="eyebrow">${active ? "Em curso" : "Recente"}</span><h3>${escapeHtml(inputLabel(job.input))}</h3></div><span class="job-state ${stateClass(job.state)}">${escapeHtml(stateLabel)}</span></div>${active || job.state === "failed" || job.state === "interrupted" ? renderTimeline(job) : `<p class="job-result">${job.state === "completed" ? "Pacote concluído e pronto a abrir." : escapeHtml(job.error?.message ?? "Processo terminado.")}</p>`}${actionsEnabled ? renderJobDecision(job) : ""}</article>`;
}

function renderTimeline(job: SafeJob): string {
  return `<ol class="editorial-timeline" aria-label="Progresso editorial">${job.stages.map((stage) => `<li class="timeline-stage is-${escapeHtml(stage.status)}"><span class="timeline-marker" aria-hidden="true"></span><div><strong>${escapeHtml(stage.label)}</strong><span class="timeline-meta">${escapeHtml(stageStatus(stage.status))}${stage.durationMs !== null ? ` · ${escapeHtml(formatDuration(stage.durationMs))}` : ""}</span>${stage.warning ? `<p class="timeline-warning">${escapeHtml(stage.warning)}</p>` : ""}${stage.artifactKinds.length > 0 ? `<span class="artifact-count">${escapeHtml(String(stage.artifactKinds.length))} artefacto(s)</span>` : ""}</div></li>`).join("")}</ol>`;
}

function renderJobDecision(job: SafeJob): string {
  if (job.state === "awaiting_angle") return `<div class="decision-desk"><div><span class="eyebrow">Decisão necessária</span><strong>Escolhe um ângulo</strong><p>Há exatamente três leituras propostas para este processo.</p></div><div class="angle-cards">${job.angles.slice(0, 3).map((angle) => `<article class="angle-card"><span class="angle-number">${escapeHtml(angle.id)}</span><h3>${escapeHtml(angle.title)}</h3><p>${escapeHtml(angle.thesis)}</p><p class="angle-why"><strong>Porque agora:</strong> ${escapeHtml(angle.whyNow)}</p><span class="evidence-count">${escapeHtml(String(angle.evidenceCount))} evidência(s)</span><button class="secondary-button angle-select" type="button" data-angle-id="${escapeHtml(angle.id)}" data-job-id="${escapeHtml(job.id)}">Escolher este ângulo</button></article>`).join("")}</div><button class="danger-quiet cancel-job" type="button" data-job-id="${escapeHtml(job.id)}">Cancelar processo</button></div>`;
  if (job.state === "awaiting_final_approval") return `<div class="decision-desk review-desk"><div><span class="eyebrow">Decisão necessária</span><strong>Revisão final</strong><p>Confirma o draft, a verificação e as saídas antes de promover o pacote.</p></div>${job.review ? `<div class="review-summary"><h3>${escapeHtml(job.review.title)}</h3><p>${escapeHtml(job.review.description)}</p><div class="review-metrics"><span>QA <b>${escapeHtml(job.review.qaVerdict)}</b></span><span>${escapeHtml(String(job.review.formatCount))} formatos</span><span>${escapeHtml(String(job.review.slideCount))} slides</span><span>${escapeHtml(String(job.review.qaWarnings))} aviso(s)</span></div></div>` : `<p class="muted">Resumo de revisão indisponível.</p>`}<div class="review-actions"><button class="secondary-button reject-job" type="button" data-job-id="${escapeHtml(job.id)}">Rejeitar</button><button class="primary-button approve-job" type="button" data-job-id="${escapeHtml(job.id)}">Aprovar</button></div><button class="danger-quiet cancel-job" type="button" data-job-id="${escapeHtml(job.id)}">Cancelar processo</button></div>`;
  if (["failed", "interrupted"].includes(job.state)) return `<div class="decision-desk"><div><span class="eyebrow">Ação disponível</span><strong>${escapeHtml(job.error?.message ?? "O processo precisa de atenção.")}</strong><p class="timeline-warning">Repetir pode repetir etapas pagas.</p>${job.rejectionNote ? `<p class="job-result"><strong>Nota:</strong> ${escapeHtml(job.rejectionNote)}</p>` : ""}</div><div class="review-actions"><button class="primary-button retry-job" type="button" data-job-id="${escapeHtml(job.id)}">Repetir etapa</button></div></div>`;
  if (!["completed", "cancelled"].includes(job.state)) return `<button class="danger-quiet cancel-job" type="button" data-job-id="${escapeHtml(job.id)}">Cancelar processo</button>`;
  return "";
}

function inputLabel(input: SafeJob["input"]): string {
  return input.kind === "url" ? safeDisplayUrl(input.url) : input.topic;
}

function safeDisplayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "URL não disponível";
  }
}

function stateCopy(state: SafeJob["state"]): string {
  const labels: Record<SafeJob["state"], string> = { queued: "Na fila", researching: "A pesquisar", source_gate: "Source gate", awaiting_angle: "A aguardar decisão", diagnosing: "Diagnóstico", drafting: "Draft", formatting: "Formatos", qa: "QA", awaiting_final_approval: "A aguardar decisão", completed: "Concluído", failed: "Falhou", cancelled: "Cancelado", interrupted: "Interrompido" };
  return labels[state];
}

function stateClass(state: SafeJob["state"]): string {
  return ["failed", "interrupted"].includes(state) ? "is-warning" : ["completed"].includes(state) ? "is-good" : ["awaiting_angle", "awaiting_final_approval"].includes(state) ? "is-decision" : "is-neutral";
}

function stageStatus(status: SafeStage["status"]): string {
  return ({ pending: "Pendente", running: "Em curso", completed: "Concluída", blocked: "Bloqueada", failed: "Falhou" } as const)[status];
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderSummary(model: CockpitModel, selected: CockpitPackage | undefined): string {
  const sourceCount = selected?.sourceGate.value?.anchors.length ?? 0;
  const formatCount = selected?.formats.length ?? 0;
  const radarCount = model.radar.value?.itemCount ?? 0;
  const qaCount = selected ? selected.qa.html.length + selected.qa.factCheck.length + selected.qa.lint.length : 0;
  return `<section class="summary" aria-label="Resumo operacional">
    <article class="summary-card summary-card--accent"><span class="summary-label">Pacote activo</span><strong>${escapeHtml(selected?.slug ?? "Sem seleção")}</strong><span>${selected?.manifest.status === "ok" ? "manifesto válido" : "manifesto com problemas"}</span></article>
    <article class="summary-card"><span class="summary-label">Radar global</span><strong>${escapeHtml(String(radarCount))}</strong><span>${model.radar.status === "ok" ? "histórias com sinal" : "sem corrida válida"}</span></article>
    <article class="summary-card"><span class="summary-label">Âncoras</span><strong>${escapeHtml(String(sourceCount))}</strong><span>fontes no source gate</span></article>
    <article class="summary-card"><span class="summary-label">Saídas</span><strong>${escapeHtml(`${formatCount}/7`)}</strong><span>${escapeHtml(String(qaCount))} evidências QA carregadas</span></article>
  </section>`;
}

function renderWarnings(warnings: string[]): string {
  return `<aside class="warnings" aria-label="Avisos de integridade"><div class="warning-icon" aria-hidden="true">!</div><div><strong>Há artefactos a confirmar</strong><ul>${warnings.slice(0, 12).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>${warnings.length > 12 ? `<p>+ ${escapeHtml(String(warnings.length - 12))} avisos adicionais.</p>` : ""}</div></aside>`;
}

function renderRadar(model: CockpitModel): string {
  const limitedNotice = model.radar.truncated ? `<span class="radar-limited">Leitura limitada à cauda do ficheiro</span>` : "";
  if (model.radar.status !== "ok" || !model.radar.value) return `${renderEmpty(model.radar.detail ?? "O radar não está disponível.")}${limitedNotice ? `<p class="radar-limited-note">${limitedNotice}</p>` : ""}`;
  const items = model.radar.value.items.map((item, index) => {
    const scoreEntries = Object.entries(item.scores).map(([key, value]) => {
      const score = Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;
      return `<span class="score-line"><span>${escapeHtml(SCORE_LABELS[key] ?? key)}</span><b>${escapeHtml(`${score}/5`)}</b><i><em style="width:${escapeHtml(`${score * 20}%`)}"></em></i></span>`;
    }).join("");
    return `<article class="radar-item"><div class="rank">${escapeHtml(String(item.rank ?? index + 1).padStart(2, "0"))}</div><div class="radar-main"><div class="item-meta"><span>${escapeHtml(item.source.toUpperCase())}</span><span>${escapeHtml(String(item.commentsCount ?? 0))} comentários</span><span>total ${escapeHtml(String(item.totalScore))}</span></div><h3>${escapeHtml(item.title)}</h3>${renderExternalLink(item.url)}<p>${escapeHtml(item.whyCollect)}</p><div class="chips">${item.signals.map((signal) => `<span class="chip">${escapeHtml(signal)}</span>`).join("")}</div><details><summary>Dimensões e ângulos</summary><div class="score-grid">${scoreEntries}</div><div class="detail-columns"><div><h4>Ângulos possíveis</h4><ul>${item.possibleAngles.map((angle) => `<li>${escapeHtml(angle)}</li>`).join("")}</ul></div><div><h4>Perguntas estratégicas</h4><ul>${item.strategicQuestions.slice(0, 3).map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul></div></div></details></div><div class="radar-score"><span>score</span><strong>${escapeHtml(String(item.totalScore))}</strong></div></article>`;
  }).join("");
  return `<div class="radar-context"><span class="live-marker"></span><strong>Global</strong><span>radar-hn · ${escapeHtml(formatDate(model.radar.runAt ?? model.radar.value.generatedAt))}</span><span class="muted">${escapeHtml(String(model.radar.value.itemCount))} itens</span>${limitedNotice}</div><div class="radar-list">${items}</div>`;
}

function renderSources(selected: CockpitPackage | undefined): string {
  const gate = selected?.sourceGate.value;
  if (!gate) return renderArtifactNotice(selected?.sourceGate, "O source-gate.json não está disponível ou é inválido.");
  const confirmed = gate.anchors.reduce((count, anchor) => count + anchor.confirmedClaims.length, 0);
  const unconfirmed = gate.anchors.reduce((count, anchor) => count + anchor.unconfirmedClaims.length, 0);
  const gateVerdict = sourceGateDecision(gate);
  return `<div class="source-overview"><div class="source-status ${gateVerdict === "PASS" ? "is-good" : "is-warning"}"><span class="eyebrow">Decisão canónica</span><strong>${escapeHtml(gateVerdict)}</strong><p>${gateVerdict === "PASS" ? "Diagnóstico autorizado pelo source gate." : gateVerdict === "HOLD" ? "Diagnóstico não autorizado pelo source gate." : "O source gate contém sinais contraditórios."}</p></div><div class="metric-card"><span>Âncoras</span><strong>${escapeHtml(String(gate.anchors.length))}</strong><small>mínimo ${escapeHtml(gate.needsExtraAnchor ? "4" : "3")}</small></div><div class="metric-card"><span>Claims confirmados</span><strong>${escapeHtml(String(confirmed))}</strong><small>por todas as âncoras</small></div><div class="metric-card"><span>Claims por confirmar</span><strong>${escapeHtml(String(unconfirmed))}</strong><small>mantidos visíveis</small></div></div><div class="source-layout"><div class="source-anchors"><h3>Âncoras canónicas</h3>${gate.anchors.map((anchor, index) => `<article class="source-card"><div class="source-number">${escapeHtml(String(index + 1).padStart(2, "0"))}</div><div><div class="item-meta"><span>${escapeHtml(anchor.sourceType)}</span><span>${escapeHtml(String(anchor.confirmedClaims.length))} confirmados</span><span>${escapeHtml(String(anchor.unconfirmedClaims.length))} por confirmar</span></div><h3>${escapeHtml(anchor.sourceName)}</h3>${renderExternalLink(anchor.sourceUrl)}<p class="risk"><strong>Risco de interpretação:</strong> ${escapeHtml(anchor.interpretationRisk)}</p><details><summary>Claims</summary><div class="claim-columns"><div><h4>Confirmados</h4><ul>${anchor.confirmedClaims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join("") || "<li>Nenhum registado.</li>"}</ul></div><div><h4>Não confirmados</h4><ul>${anchor.unconfirmedClaims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join("") || "<li>Nenhum registado.</li>"}</ul></div></div></details></div></article>`).join("")}</div><aside class="source-side"><div class="side-card"><h3>Categorias sensíveis</h3><div class="chips">${gate.sensitiveCategories.map((category) => `<span class="chip chip--warm">${escapeHtml(category)}</span>`).join("") || "<span class=\"muted\">Nenhuma registada.</span>"}</div><p>${escapeHtml(gate.notes || "Sem notas adicionais.")}</p></div><div class="side-card"><h3>Claims não suportados</h3>${gate.unsupportedClaims.map((claim) => `<div class="unsupported"><strong>${escapeHtml(claim.claim)}</strong><p>${escapeHtml(claim.whyUnsupported)}</p><span>${escapeHtml(claim.suggestedSourceType)}</span></div>`).join("") || "<p class=\"muted\">Nenhum claim não suportado registado.</p>"}</div></aside></div>`;
}

function renderMarkdownArtifact(artifact: MarkdownArtifact | undefined, empty: string, className = "") {
  if (!artifact || artifact.status !== "ok" || artifact.value === undefined) return renderArtifactNotice(artifact, empty);
  return `<article class="markdown-card ${escapeHtml(className)}"><div class="prose">${renderMarkdownSafe(artifact.value)}</div></article>`;
}

function renderFormats(selected: CockpitPackage | undefined): string {
  if (!selected) return renderEmpty("Selecione um pacote para ver os formatos.");
  const publication = selected.manifest.value;
  const tabs = selected.formats.map((format, index) => `<button class="format-tab" type="button" role="tab" tabindex="${index === 0 ? "0" : "-1"}" aria-selected="${index === 0 ? "true" : "false"}" aria-controls="format-panel-${escapeHtml(format.id)}" id="format-tab-${escapeHtml(format.id)}" data-format-id="${escapeHtml(format.id)}">${escapeHtml(format.label)}</button>`).join("");
  const panels = selected.formats.map((format, index) => `<article class="format-panel ${index === 0 ? "is-active" : ""}" role="tabpanel" aria-hidden="${index === 0 ? "false" : "true"}" id="format-panel-${escapeHtml(format.id)}" aria-labelledby="format-tab-${escapeHtml(format.id)}" data-format-panel="${escapeHtml(format.id)}">${format.markdown.status === "ok" && format.markdown.value !== undefined ? `<div class="format-meta"><span>Manifesto · ${escapeHtml(format.label)}</span><span>disponível</span></div><div class="prose">${renderMarkdownSafe(format.markdown.value)}</div>` : renderArtifactNotice(format.markdown, `O formato ${format.label} não está disponível.`)}</article>`).join("");
  const slides = publication ? publication.slides.map((slide, index) => `<li><span class="slide-index">${escapeHtml(String(index + 1).padStart(2, "0"))}</span><span><strong>${escapeHtml(slide.eyebrow)}</strong>${escapeHtml(slide.title)}</span>${slide.stat ? `<b>${escapeHtml(String(slide.stat.value))}</b>` : ""}</li>`).join("") : "";
  const previewNote = selected.indexHtml.status === "ok"
    ? "A apresentação index.html foi detetada, mas não é executada para manter a fronteira de leitura segura."
    : "O index.html não está disponível; a apresentação não é executada neste cockpit.";
  return `<div class="formats-grid"><div><div class="tabs" role="tablist" aria-label="Sete formatos de publicação">${tabs}</div><div class="format-panels">${panels}</div></div><aside class="slides-card"><div class="item-meta"><span>Resumo da apresentação</span><span>${escapeHtml(String(publication?.slides.length ?? 0))} slides</span></div><h3>${escapeHtml(publication?.title ?? "Sem manifesto")}</h3><ol>${slides || "<li>Resumo indisponível.</li>"}</ol><p class="muted">${previewNote}</p></aside></div>`;
}

function renderQa(selected: CockpitPackage | undefined): string {
  if (!selected) return renderEmpty("Selecione um pacote para ver QA.");
  const canonical = selected.qa.canonical.value;
  const canonicalVerdict = canonical ? sourceGateDecision(canonical) : undefined;
  const humanVerdict = selected.qa.humanNotes.status === "ok" && selected.qa.humanNotes.value !== undefined
    ? humanDecision(selected.qa.humanNotes.value)
    : undefined;
  const workerEvidence = [...selected.qa.html, ...selected.qa.factCheck, ...selected.qa.lint];
  const workerStates = workerEvidence.map((item) => item.artifact.status === "ok" ? conservativeEvidenceDecision(item.artifact.value) : "indisponível");
  const canonicalSignal = canonicalVerdict;
  const humanSignal = humanVerdict && isQaVerdict(humanVerdict) ? humanVerdict : "sem decisão";
  const workerSignals = workerStates.filter(isQaVerdict);
  const explicitSignals = [canonicalSignal, humanSignal, ...workerSignals].filter(isQaVerdict);
  const hasContradiction = canonicalSignal === "CONTRADITÓRIO" || workerStates.includes("CONTRADITÓRIO");
  const disagreement = hasContradiction || new Set(explicitSignals).size > 1;
  const hasFinalEditorialLint = selected.qa.lint.some((item) => item.kind === "editorial-lint" && item.final && item.artifact.status === "ok" && conservativeEvidenceDecision(item.artifact.value) === "PASS");
  const hasFinalFormatsLint = selected.qa.lint.some((item) => item.kind === "formats-lint" && item.final && item.artifact.status === "ok" && conservativeEvidenceDecision(item.artifact.value) === "PASS");
  const allRequiredPass = canonicalSignal === "PASS"
    && humanSignal === "PASS"
    && hasFinalEditorialLint
    && hasFinalFormatsLint
    && workerStates.every((state) => state === "PASS");
  const combinedVerdict = allRequiredPass
    ? "PASS"
    : disagreement
      ? "DESACORDO"
      : explicitSignals.includes("HOLD")
        ? "HOLD"
        : explicitSignals.includes("REVIEW")
          ? "REVIEW"
          : "SEM DECISÃO";
  const signalSummary = [
    canonicalVerdict ? `canónico: ${canonicalVerdict}` : "canónico: indisponível",
    humanVerdict ? `humano: ${humanVerdict}` : "humano: sem decisão explícita",
    workerEvidence.length > 0
      ? `workers: ${[...new Set(workerStates)].join(", ")}`
      : "workers: sem evidência",
  ].join(" · ");
  const canonicalBlock = canonical ? `<article class="qa-canonical"><div><span class="eyebrow">Source gate / decisão canónica</span><strong class="qa-decision ${canonicalVerdict === "PASS" ? "is-good" : "is-warning"}">${escapeHtml(canonicalVerdict ?? "indisponível")}</strong><p>${canonicalVerdict === "PASS" ? "O diagnóstico está autorizado." : canonicalVerdict === "HOLD" ? "O diagnóstico está bloqueado." : "Os sinais do source gate são contraditórios."}</p></div><dl><div><dt>Âncoras</dt><dd>${escapeHtml(String(canonical.anchors.length))}</dd></div><div><dt>Sensíveis</dt><dd>${escapeHtml(String(canonical.sensitiveCategories.length))}</dd></div><div><dt>Claims sem suporte</dt><dd>${escapeHtml(String(canonical.unsupportedClaims.length))}</dd></div></dl></article>` : renderArtifactNotice(selected.qa.canonical, "A decisão canónica não está disponível.");
  const reconciliation = `<article class="qa-reconciliation ${combinedVerdict === "PASS" ? "" : "is-conflict"}"><div><span class="eyebrow">Leitura combinada</span><strong>${escapeHtml(combinedVerdict)}</strong><p>${escapeHtml(signalSummary)}</p></div></article>`;
  const humanLabel = humanVerdict ? `humano · ${humanVerdict}` : "qa-notes";
  return `<div class="qa-stack">${canonicalBlock}${reconciliation}<div class="qa-grid"><article class="qa-card"><div class="card-heading"><h3>Notas humanas</h3><span>${escapeHtml(humanLabel)}</span></div>${selected.qa.humanNotes.status === "ok" && selected.qa.humanNotes.value !== undefined ? `<div class="prose prose--compact">${renderMarkdownSafe(selected.qa.humanNotes.value)}</div>` : `<p class="muted">${escapeHtml(selected.qa.humanNotes.detail ?? "Não disponível.")}</p>`}</article><article class="qa-card"><div class="card-heading"><h3>HTML QA</h3><span>${escapeHtml(String(selected.qa.html.length))} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.html)}</article><article class="qa-card"><div class="card-heading"><h3>Fact-check</h3><span>${escapeHtml(String(selected.qa.factCheck.length))} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.factCheck)}</article><article class="qa-card"><div class="card-heading"><h3>Lint editorial e formatos</h3><span>${escapeHtml(String(selected.qa.lint.length))} ficheiro(s)</span></div>${renderEvidenceList(selected.qa.lint)}</article></div></div>`;
}

function renderEvidenceList(items: QaEvidence[]): string {
  if (items.length === 0) return `<p class="muted">Nenhuma evidência disponível.</p>`;
  return `<div class="evidence-list">${items.map((item) => {
    const decision = item.artifact.status === "ok" ? conservativeEvidenceDecision(item.artifact.value) : "indisponível";
    return `<details class="evidence"><summary><span>${escapeHtml(item.provider)}</span><span class="evidence-kind">${escapeHtml(item.kind)}</span><span>${item.final ? "final" : "não final"}</span><b class="evidence-status ${decision === "PASS" ? "is-good" : "is-warning"}">${escapeHtml(decision)}</b></summary>${item.artifact.status === "ok" ? `<pre>${escapeHtml(formatEvidence(item.artifact.value))}</pre>` : `<p class="muted">${escapeHtml(item.artifact.detail ?? "Artefacto inválido.")}</p>`}</details>`;
  }).join("")}</div>`;
}

export function evidenceDecision(value: unknown): string {
  return conservativeEvidenceDecision(value);
}

function sourceGateDecision(value: SourceGateResult): QaSignal {
  const requiredAnchors = value.sensitiveCategories.length > 0 ? 4 : 3;
  const expectedPass = value.anchors.length >= requiredAnchors;
  const consistent = value.minimumAnchorsFound === value.anchors.length
    && value.needsExtraAnchor === (value.sensitiveCategories.length > 0)
    && value.pass === expectedPass
    && value.diagnosisAllowed === expectedPass;
  if (!consistent) return "CONTRADITÓRIO";
  return expectedPass ? "PASS" : "HOLD";
}

function conservativeEvidenceDecision(value: unknown): QaSignal {
  if (!isRecord(value)) return "sem decisão";
  const hasModelVerdict = Object.prototype.hasOwnProperty.call(value, "model_verdict");
  const hasPass = Object.prototype.hasOwnProperty.call(value, "pass");
  const modelVerdict = typeof value.model_verdict === "string" ? parseExplicitVerdict(value.model_verdict) : undefined;
  const passVerdict = typeof value.pass === "boolean" ? (value.pass ? "PASS" : "HOLD") : undefined;
  if ((hasModelVerdict && typeof value.model_verdict !== "string") || (hasPass && !passVerdict)) return "CONTRADITÓRIO";
  if (isRecord(value.presentation) && Array.isArray(value.presentation.consoleErrors) && value.presentation.consoleErrors.length > 0) {
    return modelVerdict === "PASS" || passVerdict === "PASS" ? "CONTRADITÓRIO" : "HOLD";
  }
  if (modelVerdict === "PASS" && passVerdict === "HOLD") return "CONTRADITÓRIO";
  if (modelVerdict && modelVerdict !== "PASS" && passVerdict === "PASS") return "CONTRADITÓRIO";
  if (modelVerdict) return modelVerdict;
  if (passVerdict) return passVerdict;
  if (isRecord(value.presentation) && Array.isArray(value.presentation.consoleErrors)) {
    return value.presentation.consoleErrors.length === 0 ? "sem erros" : "HOLD";
  }
  return "sem decisão";
}

function isQaVerdict(value: string | undefined): value is QaVerdict {
  return value === "PASS" || value === "HOLD" || value === "REVIEW";
}

function humanDecision(value: string): string | undefined {
  const explicit = value.match(/(?:decis(?:ão|ion)|verdict|status|resultado)\s*[:=-]\s*([a-záéíóú_-]+)/iu)?.[1];
  return explicit ? parseExplicitVerdict(explicit) : undefined;
}

function parseExplicitVerdict(value: string): QaVerdict | undefined {
  const normalised = value.trim().toLowerCase().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
  if (/^(?:pass|passed|approved|approve|aprovado|aprovada|sucesso|ok)$/u.test(normalised)) return "PASS";
  if (/^(?:hold|fail|failed|blocked|block|bloqueado|bloqueada|rejeitado|rejeitada|erro)$/u.test(normalised)) return "HOLD";
  if (/^(?:review|revisão|revisao|needs review|manual|manual review)$/u.test(normalised)) return "REVIEW";
  return undefined;
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

function renderExternalLink(value: string): string {
  const safe = safeExternalUrl(value);
  if (!safe) return `<span class="safe-url" aria-label="URL não disponível">URL não disponível</span>`;
  return `<a class="safe-url" href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${escapeHtml(displayUrl(safe))}</a>`;
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
    .replace(/data\s*:/giu, "");
}

function redactSecrets(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => safeUrlReplacement(candidate))
    .replace(/\b(?:run|doc|document)_[a-z0-9][a-z0-9_-]*\b/giu, "[identificador omitido]")
    .replace(/(?:api[_ -]?key|access[_ -]?token|secret|authorization|bearer|password|passwd|cookie|session|private[_ -]?key|auth)\s*[:=]\s*[^\s,;]+/giu, "[conteúdo omitido]")
    .replace(/\b(?:sk|fc)-[a-z0-9][a-z0-9_-]{8,}\b/giu, "[conteúdo omitido]")
    .replace(/(?:\/home\/|\/tmp\/|[A-Z]:\\)[^\s<>"']*/gu, "[caminho omitido]");
}

function safeUrlReplacement(candidate: string): string {
  const trailing = candidate.match(/[),.;]+$/u)?.[0] ?? "";
  const core = trailing ? candidate.slice(0, -trailing.length) : candidate;
  return `${safeExternalUrl(core) ?? "[URL omitido]"}${trailing}`;
}

function stripUnsafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientScript(csrfToken: string): string {
  return `(() => {
  const csrfToken = ${JSON.stringify(csrfToken)};
  let actionsEnabled = document.getElementById('controlo')?.getAttribute('data-actions-enabled') === 'true';
  let runnerReady = document.getElementById('controlo')?.getAttribute('data-runner-ready') === 'true';
  const select = document.getElementById('package-select');
  const jobsRoot = document.getElementById('control-jobs');
  const status = document.getElementById('control-status');
  const dialog = document.getElementById('compose-dialog');
  const rejectDialog = document.getElementById('reject-dialog');
  const rejectForm = document.getElementById('reject-form');
  const rejectNote = document.getElementById('reject-note');
  let rejectingJobId;
  let rejectTrigger;
  const form = document.getElementById('compose-form');
  const sourceValue = document.getElementById('compose-value');
  const sourceLabel = document.getElementById('compose-value-label');
  const contextValue = document.getElementById('compose-context');
  const htmlToggle = document.getElementById('compose-html');
  const composeError = document.getElementById('compose-error');
  const rejectError = document.getElementById('reject-error');
  let composeTrigger;
  let lastJobStates = new Map();
  let polling = false;
  let pollTimer;

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

  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function button(label, className, handler, attributes) {
    const node = element('button', label, className);
    node.type = 'button';
    Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }
  function renderJob(job) {
    const card = element('article', undefined, 'job-card' + (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state) ? '' : ' is-active'));
    card.dataset.jobId = job.id;
    const head = element('div', undefined, 'job-card-head');
    const copy = element('div');
    copy.append(element('span', 'Processo editorial', 'eyebrow'), element('h3', job.input.kind === 'url' ? safeDisplayUrl(job.input.url) : job.input.topic));
    head.append(copy, element('span', stateLabel(job.state), 'job-state ' + stateClass(job.state)));
    card.append(head);
    if (job.stages) {
      const timeline = element('ol', undefined, 'editorial-timeline');
      job.stages.forEach((stage) => {
        const item = element('li', undefined, 'timeline-stage is-' + stage.status);
        const body = element('div');
        body.append(element('span', '', 'timeline-marker'), element('strong', stage.label), element('span', (stage.status === 'running' ? 'Em curso' : stage.status === 'completed' ? 'Concluída' : stage.status === 'failed' ? 'Falhou' : stage.status === 'blocked' ? 'Bloqueada' : 'Pendente') + (stage.durationMs !== null && stage.durationMs !== undefined ? ' · ' + formatStageDuration(stage.durationMs) : ''), 'timeline-meta'));
        if (stage.warning) body.append(element('p', stage.warning, 'timeline-warning'));
        if (Array.isArray(stage.artifactKinds) && stage.artifactKinds.length) body.append(element('span', stage.artifactKinds.length + ' artefacto(s)', 'artifact-count'));
        item.append(body);
        timeline.append(item);
      });
      card.append(timeline);
    }
    if (actionsEnabled && runnerReady && job.state === 'awaiting_angle' && Array.isArray(job.angles)) {
      const desk = element('div', undefined, 'decision-desk');
      desk.append(element('strong', 'Escolhe um ângulo'));
      const cards = element('div', undefined, 'angle-cards');
      job.angles.slice(0, 3).forEach((angle) => {
        const candidate = element('article', undefined, 'angle-card');
        candidate.append(element('h3', angle.title), element('p', angle.thesis), element('p', 'Porque agora: ' + angle.whyNow, 'angle-why'), element('span', angle.evidenceCount + ' evidência(s)', 'evidence-count'));
        candidate.append(button('Escolher este ângulo', 'secondary-button angle-select', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/select-angle', { angleId: angle.id }), { 'data-job-id': job.id, 'data-angle-id': angle.id }));
        cards.append(candidate);
      });
      desk.append(cards, button('Cancelar processo', 'danger-quiet cancel-job', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/cancel', {}), { 'data-job-id': job.id }));
      card.append(desk);
    } else if (actionsEnabled && runnerReady && job.state === 'awaiting_final_approval') {
      const desk = element('div', undefined, 'decision-desk review-desk');
      desk.append(element('strong', 'Revisão final'));
      if (job.review) desk.append(element('h3', job.review.title), element('p', job.review.description), element('p', 'QA ' + job.review.qaVerdict + ' · ' + job.review.formatCount + ' formatos · ' + job.review.slideCount + ' slides'));
      const actions = element('div', undefined, 'review-actions');
      actions.append(button('Rejeitar', 'secondary-button reject-job', () => rejectJob(job.id), { 'data-job-id': job.id }), button('Aprovar', 'primary-button approve-job', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/approve', { decision: 'approve' }), { 'data-job-id': job.id }));
      desk.append(actions, button('Cancelar processo', 'danger-quiet cancel-job', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/cancel', {}), { 'data-job-id': job.id }));
      card.append(desk);
    } else if (actionsEnabled && runnerReady && (job.state === 'failed' || job.state === 'interrupted')) {
      card.append(element('p', 'Repetir pode repetir etapas pagas.', 'timeline-warning'));
      if (job.rejectionNote) card.append(element('p', 'Nota: ' + job.rejectionNote, 'job-result'));
      card.append(button('Repetir etapa', 'primary-button retry-job', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/retry', {}), { 'data-job-id': job.id }));
    } else if (actionsEnabled && runnerReady && ['queued', 'researching', 'source_gate', 'diagnosing', 'drafting', 'formatting', 'qa'].includes(job.state)) {
      card.append(button('Cancelar processo', 'danger-quiet cancel-job', () => mutate('/api/jobs/' + encodeURIComponent(job.id) + '/cancel', {}), { 'data-job-id': job.id }));
    }
    return card;
  }
  function formatStageDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value) / 1000));
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
  }
  function stateLabel(value) {
    return ({ queued: 'Na fila', researching: 'A pesquisar', source_gate: 'Source gate', awaiting_angle: 'A aguardar decisão', diagnosing: 'Diagnóstico', drafting: 'Draft', formatting: 'Formatos', qa: 'QA', awaiting_final_approval: 'A aguardar decisão', completed: 'Concluído', failed: 'Falhou', cancelled: 'Cancelado', interrupted: 'Interrompido' })[value] || 'Estado do processo';
  }
  function stateClass(value) {
    return value === 'completed' ? 'is-good' : value === 'failed' || value === 'interrupted' ? 'is-warning' : value === 'awaiting_angle' || value === 'awaiting_final_approval' ? 'is-decision' : 'is-neutral';
  }
  function safeDisplayUrl(value) {
    try { const parsed = new URL(value); parsed.search = ''; parsed.hash = ''; return parsed.toString(); } catch { return 'URL não disponível'; }
  }
  function updateActionState(jobs, nextActionsEnabled = actionsEnabled, nextRunnerReady = runnerReady) {
    const section = document.getElementById('controlo');
    actionsEnabled = nextActionsEnabled === true;
    runnerReady = nextRunnerReady === true;
    section?.setAttribute('data-actions-enabled', String(actionsEnabled));
    section?.setAttribute('data-runner-ready', String(runnerReady));
    const available = actionsEnabled && runnerReady;
    const label = !actionsEnabled ? 'Apenas leitura' : runnerReady ? 'Ações disponíveis' : 'Configuração necessária';
    const active = jobs.some((job) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state));
    document.querySelectorAll('[data-action-state]').forEach((node) => { node.textContent = label; });
    const newContent = document.getElementById('new-content');
    if (newContent) newContent.disabled = !available || active;
    if (status && !status.classList.contains('is-error')) { status.textContent = label; status.classList.toggle('is-off', !available); status.classList.toggle('is-on', available); }
  }
  function announceJobs(jobs) {
    const next = new Map(jobs.map((job) => [job.id, job.state]));
    const changed = jobs.find((job) => lastJobStates.has(job.id) && lastJobStates.get(job.id) !== job.state);
    if (changed) announce('Processo atualizado: ' + stateLabel(changed.state));
    lastJobStates = next;
  }
  function announce(message) {
    const node = document.getElementById('control-announcement');
    if (!node) return;
    node.textContent = '';
    window.setTimeout(() => { node.textContent = message; }, 0);
  }
  function renderJobs(jobs, nextActionsEnabled = actionsEnabled, nextRunnerReady = runnerReady) {
    if (!jobsRoot) return;
    updateActionState(jobs, nextActionsEnabled, nextRunnerReady);
    announceJobs(jobs);
    const target = jobs.find((job) => job.state === 'completed' && job.packageSlug);
    if (target && select) {
      select.value = target.packageSlug;
      const url = new URL(window.location.href);
      url.searchParams.set('package', target.packageSlug);
      const current = new URL(window.location.href).searchParams.get('package');
      if (current !== target.packageSlug) window.location.assign(url.pathname + url.search + window.location.hash);
    }
    jobsRoot.replaceChildren();
    if (!jobs.length) jobsRoot.append(element('p', 'Ainda não existem processos controlados pelo cockpit.', 'muted'));
    jobs.slice(0, 4).forEach((job) => jobsRoot.append(renderJob(job)));
  }
  async function mutate(path, payload) {
    if (!actionsEnabled || !runnerReady) return false;
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(payload), credentials: 'same-origin' });
      let body = {};
      try { body = await response.json(); } catch { /* empty response */ }
      if (!response.ok) throw new Error(body.error?.message || 'A operação não pôde ser concluída.');
      await poll();
      return response.status === 202;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'A operação não pôde ser concluída.';
      if (status) { status.textContent = message; status.classList.add('is-off', 'is-error'); }
      if (path === '/api/jobs' || path.endsWith('/api/jobs')) showDialogError(composeError, message);
      if (rejectingJobId && path.includes('/approve')) showDialogError(rejectError, message);
      return false;
    }
  }
  function showDialogError(node, message) {
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }
  function rejectJob(id) {
    rejectingJobId = id;
    rejectTrigger = document.activeElement;
    if (rejectNote) rejectNote.value = '';
    if (rejectError) rejectError.hidden = true;
    if (rejectDialog?.showModal) { rejectDialog.showModal(); window.setTimeout(() => rejectNote?.focus(), 0); }
  }
  function closeDialogSafely(target, trigger) { if (target?.open) target.close(); window.setTimeout(() => trigger?.focus(), 0); }
  document.getElementById('reject-close')?.addEventListener('click', () => closeDialogSafely(rejectDialog, rejectTrigger));
  document.getElementById('reject-cancel')?.addEventListener('click', () => closeDialogSafely(rejectDialog, rejectTrigger));
  rejectDialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeDialogSafely(rejectDialog, rejectTrigger); });
  rejectForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = rejectNote?.value.trim() || undefined;
    if (rejectingJobId && await mutate('/api/jobs/' + encodeURIComponent(rejectingJobId) + '/approve', note ? { decision: 'reject', note } : { decision: 'reject' })) closeDialogSafely(rejectDialog, rejectTrigger);
  });
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const response = await fetch('/api/jobs', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (Array.isArray(data.jobs)) renderJobs(data.jobs, data.actionsEnabled, data.runnerReady);
      const active = Array.isArray(data.jobs) && data.jobs.some((job) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state));
      if (active) {
        const current = data.jobs.find((job) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state));
        if (current) {
          const detailResponse = await fetch('/api/jobs/' + encodeURIComponent(current.id), { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
          if (detailResponse.ok) { const detail = await detailResponse.json(); if (detail.job) renderJobs([detail.job].concat(data.jobs.filter((job) => job.id !== detail.job.id))); }
        }
      }
    } catch { /* A próxima consulta recupera um cockpit temporariamente indisponível. */ }
    finally { polling = false; schedulePoll(); }
  }
  function schedulePoll() { if (pollTimer) window.clearTimeout(pollTimer); pollTimer = window.setTimeout(() => void poll(), 2500); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  jobsRoot?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target || !jobsRoot.contains(target)) return;
    const id = target.getAttribute('data-job-id') || '';
    if (target.classList.contains('angle-select')) void mutate('/api/jobs/' + encodeURIComponent(id) + '/select-angle', { angleId: target.getAttribute('data-angle-id') || '' });
    else if (target.classList.contains('cancel-job')) void mutate('/api/jobs/' + encodeURIComponent(id) + '/cancel', {});
    else if (target.classList.contains('approve-job')) void mutate('/api/jobs/' + encodeURIComponent(id) + '/approve', { decision: 'approve' });
    else if (target.classList.contains('reject-job')) rejectJob(id);
    else if (target.classList.contains('retry-job')) void mutate('/api/jobs/' + encodeURIComponent(id) + '/retry', {});
  });

  function openCompose() { if (actionsEnabled && runnerReady && dialog?.showModal) { composeTrigger = document.activeElement; if (composeError) composeError.hidden = true; dialog.showModal(); window.setTimeout(() => sourceValue?.focus(), 0); } }
  function closeCompose() { closeDialogSafely(dialog, composeTrigger); }
  document.getElementById('new-content')?.addEventListener('click', openCompose);
  document.getElementById('compose-close')?.addEventListener('click', closeCompose);
  document.getElementById('compose-cancel')?.addEventListener('click', closeCompose);
  dialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeCompose(); });
  document.querySelectorAll('input[name="source-kind"]').forEach((radio) => radio.addEventListener('change', () => {
    const topic = radio.value === 'topic';
    if (radio.checked && sourceLabel && sourceValue) { sourceLabel.textContent = topic ? 'Tema' : 'URL'; sourceValue.type = topic ? 'text' : 'url'; sourceValue.setAttribute('placeholder', topic ? 'O que queres investigar?' : 'https://exemplo.pt/artigo'); sourceValue.setAttribute('inputmode', topic ? 'text' : 'url'); sourceValue.setAttribute('autocomplete', topic ? 'off' : 'url'); }
  }));
  document.getElementById('compose-next')?.addEventListener('click', () => {
    if (!form?.reportValidity()) return;
    const confirmation = document.getElementById('compose-confirmation');
    const kind = document.querySelector('input[name="source-kind"]:checked')?.value || 'url';
    if (confirmation) { confirmation.replaceChildren(); [['Entrada', kind === 'topic' ? 'Tema' : 'URL'], [kind === 'topic' ? 'Tema' : 'URL', sourceValue.value.trim()], ['Contexto', contextValue?.value.trim() || 'Sem contexto adicional'], ['Saída', 'Blog + formatos'], ['HTML', htmlToggle?.checked ? 'Sim' : 'Não']].forEach(([label, value]) => { const term = element('dt', label); const detail = element('dd', value); confirmation.append(term, detail); }); }
    document.getElementById('compose-step-input')?.setAttribute('hidden', ''); document.getElementById('compose-step-confirm')?.removeAttribute('hidden'); document.getElementById('compose-submit')?.focus();
  });
  document.getElementById('compose-back')?.addEventListener('click', () => { document.getElementById('compose-step-confirm')?.setAttribute('hidden', ''); document.getElementById('compose-step-input')?.removeAttribute('hidden'); sourceValue?.focus(); });
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const kind = document.querySelector('input[name="source-kind"]:checked')?.value || 'url';
    const payload = kind === 'topic' ? { kind: 'topic', topic: sourceValue?.value.trim() || '', context: contextValue?.value.trim() || '', output: 'blog-formats', exportHtml: Boolean(htmlToggle?.checked) } : { kind: 'url', url: sourceValue?.value.trim() || '', context: contextValue?.value.trim() || '', output: 'blog-formats', exportHtml: Boolean(htmlToggle?.checked) };
    if (await mutate('/api/jobs', payload)) closeCompose();
  });
  schedulePoll();
})();`;
}

function styles(): string {
  return `
:root { color-scheme: light; --ink:#162026; --ink-soft:#415057; --paper:#f4f4f0; --card:#fff; --line:#d7dcd9; --line-strong:#b8c1bd; --teal:#14766b; --teal-soft:#dcefe9; --amber:#a55b18; --amber-soft:#fff0dc; --red:#a83735; --shadow:0 10px 30px rgba(21,35,35,.06); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-bottom:calc(24px + env(safe-area-inset-bottom)); }
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
.control-plane { margin:24px clamp(24px,5vw,76px) 0; padding:22px; border:1px solid var(--line-strong); border-radius:9px; background:#e9f2ee; }
.control-plane-heading { display:flex; justify-content:space-between; gap:24px; align-items:end; }
.control-plane-heading h2 { font-size:clamp(1.5rem,2.4vw,2.4rem); }
.control-plane-actions { display:flex; align-items:center; gap:12px; }
.control-status { display:inline-flex; min-height:32px; align-items:center; gap:7px; padding:0 10px; border:1px solid #b8d8ce; border-radius:999px; color:#22685e; font-size:.67rem; font-weight:850; }
.control-status.is-off { border-color:#e6c596; background:var(--amber-soft); color:#80501f; }
.primary-button, .secondary-button, .danger-quiet, .icon-button { display:inline-flex; min-height:44px; align-items:center; justify-content:center; padding:0 15px; border:1px solid transparent; border-radius:5px; cursor:pointer; font-size:.74rem; font-weight:850; }
.primary-button { background:var(--ink); color:var(--paper); }
.secondary-button { border-color:var(--line-strong); background:var(--card); color:var(--ink); }
.danger-quiet { padding-inline:0; border:0; background:transparent; color:var(--red); text-decoration:underline; text-underline-offset:3px; }
.primary-button:disabled, .secondary-button:disabled, .danger-quiet:disabled { cursor:not-allowed; opacity:.5; }
.primary-button:active, .secondary-button:active, .danger-quiet:active, .icon-button:active { transform:scale(.98); }
.control-jobs { display:grid; gap:10px; margin-top:20px; }
.job-card { min-width:0; padding:18px; border:1px solid var(--line); border-radius:7px; background:var(--card); box-shadow:var(--shadow); }
.job-card.is-active { border-left:4px solid var(--teal); }
.job-card-head { display:flex; justify-content:space-between; gap:16px; align-items:start; }
.job-card-head h3 { max-width:760px; margin-top:7px; font-size:1rem; }
.job-state { display:inline-flex; min-height:28px; align-items:center; padding:0 9px; border-radius:999px; background:#edf0ed; color:var(--ink-soft); font-size:.65rem; font-weight:850; white-space:nowrap; }
.job-state.is-good { background:var(--teal-soft); color:#24675f; }
.job-state.is-warning, .job-state.is-decision { background:var(--amber-soft); color:#80501f; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.dialog-error { margin:-5px 0 0; padding:10px 12px; border-left:3px solid var(--red); background:#fff0ed; color:var(--red); font-size:.75rem; line-height:1.4; }
.job-result { margin:14px 0 0; color:var(--ink-soft); font-size:.78rem; }
.editorial-timeline { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:7px; margin:18px 0 0; padding:0; list-style:none; }
.timeline-stage { position:relative; min-width:0; min-height:75px; padding:10px 8px; border-top:2px solid var(--line); }
.timeline-stage.is-running { border-color:var(--teal); background:#f1faf6; }
.timeline-stage.is-completed { border-color:#8ec4b7; }
.timeline-stage.is-blocked, .timeline-stage.is-failed { border-color:var(--amber); background:var(--amber-soft); }
.timeline-marker { display:inline-block; width:8px; height:8px; margin-bottom:8px; border-radius:50%; background:var(--line-strong); }
.timeline-stage.is-running .timeline-marker { background:var(--teal); }
.timeline-stage.is-completed .timeline-marker { background:#55a99a; }
.timeline-stage strong { display:block; font-size:.68rem; line-height:1.25; }
.timeline-meta, .artifact-count { display:block; margin-top:4px; color:var(--ink-soft); font-size:.61rem; line-height:1.3; }
.timeline-warning { margin:5px 0 0; color:#80501f; font-size:.61rem; line-height:1.3; }
.decision-desk { display:grid; gap:14px; margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }
.decision-desk > div:first-child strong { display:block; margin-top:6px; font-size:1.1rem; }
.decision-desk > div:first-child p { margin:6px 0 0; color:var(--ink-soft); font-size:.74rem; }
.angle-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.angle-card { display:flex; min-width:0; flex-direction:column; align-items:flex-start; padding:14px; border:1px solid var(--line); border-radius:6px; background:#fbfcf9; }
.angle-number, .evidence-count { color:var(--teal); font-size:.61rem; font-weight:850; letter-spacing:.08em; text-transform:uppercase; }
.angle-card h3 { margin-top:8px; }
.angle-card p { margin:8px 0 0; color:var(--ink-soft); font-size:.74rem; line-height:1.45; }
.angle-card .angle-why { font-size:.68rem; }
.angle-card .evidence-count { margin-top:10px; }
.angle-card button { width:100%; margin-top:12px; }
.review-summary { padding:14px; border:1px solid var(--line); border-radius:6px; background:#fbfcf9; }
.review-summary h3 { font-size:1.25rem; }
.review-summary p { margin:7px 0 0; color:var(--ink-soft); font-size:.78rem; line-height:1.5; }
.review-metrics { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:12px; color:var(--ink-soft); font-size:.68rem; }
.review-metrics b { color:var(--teal); }
.review-actions { display:flex; justify-content:flex-end; gap:8px; }
.compose-dialog { width:min(600px,calc(100vw - 32px)); max-width:100%; padding:0; border:0; border-radius:10px; background:var(--paper); color:var(--ink); box-shadow:0 24px 80px rgba(21,35,35,.24); }
.compose-dialog::backdrop { background:rgba(22,32,38,.42); }
.compose-dialog form { padding:24px; }
.dialog-head { display:flex; justify-content:space-between; gap:20px; align-items:start; margin-bottom:24px; }
.dialog-head h2 { font-size:2rem; }
.icon-button { width:44px; padding:0; border-color:var(--line); background:var(--card); font-size:1.4rem; font-weight:400; }
.compose-dialog fieldset { margin:0 0 20px; padding:0; border:0; }
.compose-dialog legend, .field-label { display:block; margin-bottom:8px; color:var(--ink-soft); font-size:.68rem; font-weight:850; letter-spacing:.09em; text-transform:uppercase; }
.choice-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.choice-card { display:flex; min-height:74px; align-items:flex-start; gap:10px; padding:12px; border:1px solid var(--line-strong); border-radius:6px; background:var(--card); cursor:pointer; }
.choice-card:has(input:checked) { border-color:var(--teal); box-shadow:inset 0 0 0 1px var(--teal); }
.choice-card input { margin-top:3px; accent-color:var(--teal); }
.choice-card strong, .choice-card small, .toggle-row strong, .toggle-row small { display:block; }
.choice-card strong, .toggle-row strong { font-size:.76rem; }
.choice-card small, .toggle-row small { margin-top:4px; color:var(--ink-soft); font-size:.68rem; line-height:1.35; }
.field-label span { font-weight:500; letter-spacing:0; text-transform:none; }
.text-input { width:100%; margin-bottom:17px; padding:11px 12px; border:1px solid var(--line-strong); border-radius:5px; background:var(--card); color:var(--ink); font:inherit; font-size:.84rem; line-height:1.4; }
textarea.text-input { resize:vertical; }
.fixed-output { display:grid; gap:4px; margin:2px 0 15px; padding:13px; border-left:3px solid var(--teal); background:var(--teal-soft); }
.fixed-output strong { font-size:.85rem; }
.fixed-output > span:last-child { color:var(--ink-soft); font-size:.69rem; }
.toggle-row { display:flex; gap:10px; align-items:flex-start; padding:12px 0; cursor:pointer; }
.toggle-row input { width:18px; height:18px; margin:0; accent-color:var(--teal); }
.dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:20px; }
.confirmation { display:grid; grid-template-columns:120px minmax(0,1fr); gap:0; margin:18px 0; }
.confirmation dt, .confirmation dd { margin:0; padding:10px 0; border-bottom:1px solid var(--line); font-size:.75rem; overflow-wrap:anywhere; }
.confirmation dt { color:var(--ink-soft); font-weight:800; }
.confirmation dd { color:var(--ink); }
.confirm-note { color:var(--ink-soft); font-size:.76rem; line-height:1.45; }
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
@media (hover: hover) and (pointer: fine) { .section-nav a:hover { color:var(--ink); background:rgba(255,255,255,.56); } .safe-url:hover { text-decoration-color:currentColor; } }
@media (max-width:900px) { .app-shell { grid-template-columns:168px minmax(0,1fr); } .topbar { gap:22px; } .topbar-controls { flex-basis:190px; } .source-layout, .formats-grid { grid-template-columns:1fr; } }
@media (max-width:680px) { html { scroll-behavior:auto; } body { min-width:0; } .mobile-header { position:sticky; top:0; z-index:10; display:flex; align-items:center; justify-content:space-between; min-height:calc(54px + env(safe-area-inset-top)); padding:env(safe-area-inset-top) 16px 0; border-bottom:1px solid var(--line); background:rgba(244,244,240,.97); } .sidebar { position:sticky; top:calc(54px + env(safe-area-inset-top)); z-index:9; display:block; width:100%; height:auto; padding:0; border-right:0; border-bottom:1px solid var(--line); } .brand-block, .sidebar-foot { display:none; } .app-shell { display:block; } .section-nav { display:flex; gap:3px; margin:0; padding:5px 12px; overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:none; } .section-nav::-webkit-scrollbar { display:none; } .section-nav a { flex:0 0 auto; min-height:44px; padding:0 11px; border-left:0; border-bottom:2px solid transparent; white-space:nowrap; } .topbar { display:block; padding:28px 16px 22px; } .topbar-copy h1 { font-size:2.5rem; } .topbar-controls { margin-top:23px; } .summary { grid-template-columns:repeat(2,minmax(0,1fr)); padding:14px 16px; } .summary-card { min-height:96px; padding:12px; } .summary-card strong { font-size:1rem; } .warnings { margin:14px 16px 0; } .section { scroll-margin-top:calc(112px + env(safe-area-inset-top)); padding:43px 16px 0; } .section-heading { display:block; margin-bottom:17px; } .section-note { margin-top:12px; } .radar-item { grid-template-columns:27px minmax(0,1fr) 48px; gap:8px; } .radar-score strong { font-size:1.7rem; } .score-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .detail-columns, .claim-columns, .qa-grid, .source-overview { grid-template-columns:1fr; } .source-card { grid-template-columns:27px minmax(0,1fr); padding:14px; } .qa-canonical { display:block; } .qa-canonical dl { margin-top:20px; justify-content:space-between; } .markdown-card { padding:20px 17px; } .prose { font-size:1rem; } .format-panel { padding:17px; } .evidence summary { display:flex; flex-wrap:wrap; gap:6px 10px; } .evidence summary > span:first-child { flex:1 1 100%; } .evidence summary > b { margin-left:auto; } .footer { display:block; margin:24px 16px 0; } .footer span { display:block; margin-top:5px; } }
@media (max-width:680px) { .control-plane { margin:14px 16px 0; padding:16px; } .control-plane-heading { display:block; } .control-plane-actions { display:grid; grid-template-columns:1fr; gap:8px; margin-top:18px; } .control-status { justify-content:center; } .editorial-timeline { grid-template-columns:1fr; gap:0; margin-top:14px; } .timeline-stage { min-height:0; padding:10px 10px 10px 23px; border-top:0; border-left:2px solid var(--line); } .timeline-stage.is-running, .timeline-stage.is-completed, .timeline-stage.is-blocked, .timeline-stage.is-failed { border-left-color:var(--teal); border-top:0; } .timeline-marker { position:absolute; top:14px; left:-5px; margin:0; } .angle-cards { grid-template-columns:1fr; } .review-actions { position:sticky; bottom:0; z-index:4; margin:0 -16px; padding:10px 16px calc(10px + env(safe-area-inset-bottom)); background:rgba(244,244,240,.97); border-top:1px solid var(--line); } .review-actions button { flex:1; } .compose-dialog { width:100%; max-width:none; height:100dvh; max-height:none; margin:0; border-radius:0; } .compose-dialog form { display:flex; min-height:100%; flex-direction:column; padding:18px 16px; } .compose-step { flex:1; } .dialog-actions { position:sticky; bottom:0; margin-inline:-16px; padding:12px 16px calc(12px + env(safe-area-inset-bottom)); background:rgba(244,244,240,.98); border-top:1px solid var(--line); } .dialog-actions button { flex:1; } }
@media (prefers-reduced-motion:reduce) { *, *::before, *::after { scroll-behavior:auto !important; transition-duration:0.01ms !important; animation-duration:0.01ms !important; } }
`;
}
