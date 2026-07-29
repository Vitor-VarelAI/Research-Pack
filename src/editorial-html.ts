import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { PUBLICATION_FORMAT_IDS, type Publication, type PublicationFormatId } from "./schemas/publication.js";

export type RenderedFormat = {
  id: PublicationFormatId;
  label: string;
  plainText: string;
  richHtml: string;
};

export type EditorialHtmlData = {
  title: string;
  description: string;
  publishedOn: string;
  slides: Array<{
    id: string;
    eyebrow: string;
    title: string;
    bodyHtml: string;
    theme: Publication["slides"][number]["theme"];
    stat?: { value: string; label: string };
  }>;
  formats: RenderedFormat[];
};

const ALLOWED_MARKDOWN_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_MARKDOWN_TAGS,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

export function buildEditorialHtmlData(publication: Publication, markdownByPath: ReadonlyMap<string, string>): EditorialHtmlData {
  const slides = publication.slides.map((slide) => ({
    id: slide.id,
    eyebrow: slide.eyebrow,
    title: slide.title,
    bodyHtml: renderMarkdown(getMarkdown(markdownByPath, `slide:${slide.id}`, slide.bodyMarkdown)),
    theme: slide.theme,
    ...(slide.stat
      ? { stat: { value: String(slide.stat.value), label: slide.stat.label } }
      : {}),
  }));

  const formats = PUBLICATION_FORMAT_IDS.map((id) => {
    const format = publication.formats[id];
    const markdown = getMarkdown(markdownByPath, `format:${id}`, "");
    const richHtml = renderMarkdown(markdown);
    return {
      id,
      label: format.label,
      plainText: markdownToPlainText(richHtml),
      richHtml,
    };
  });

  return {
    title: publication.title,
    description: publication.description,
    publishedOn: publication.publishedOn,
    slides,
    formats,
  };
}

export function renderEditorialHtml(data: EditorialHtmlData): string {
  const title = escapeHtml(data.title);
  const description = escapeHtml(data.description);
  const serializedData = safeJsonForScript(data);
  const slidesHtml = data.slides.map((slide, index) => renderSlide(slide, index)).join("\n");
  const dotsHtml = data.slides.map((slide, index) => {
    const current = index === 0 ? ' aria-current="true"' : "";
    return `<button class="dot" type="button" data-slide-index="${index}" aria-label="Ir para o slide ${index + 1}: ${escapeHtml(slide.title)}"${current}></button>`;
  }).join("\n");
  const formatsHtml = data.formats.map(renderFormatPanel).join("\n");
  const tabsHtml = data.formats.map((format, index) => {
    const selected = index === 0;
    return `<button class="format-tab" type="button" role="tab" id="tab-${escapeHtml(format.id)}" aria-controls="format-${escapeHtml(format.id)}" aria-selected="${selected ? "true" : "false"}" data-format-id="${escapeHtml(format.id)}">${escapeHtml(format.label)}</button>`;
  }).join("\n");

  return `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #171717;
      --paper: #f4f1ea;
      --sand: #d9c7aa;
      --blue: #173d5b;
      --red: #8d2f2b;
      --muted: color-mix(in srgb, currentColor 64%, transparent);
      --line: color-mix(in srgb, currentColor 20%, transparent);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body { background: var(--paper); color: var(--ink); overflow: hidden; }
    body:not(.js-ready) { overflow: auto; }
    body.js-ready .formats-view { display: none; }
    body.js-ready.formats-mode { overflow: hidden; }
    body.js-ready.formats-mode .presentation-view { display: none; }
    body.js-ready.formats-mode .formats-view { display: block; }
    body.js-ready.formats-mode .topbar { display: none; }
    .no-js-only { display: inline-flex; }
    body.js-ready .no-js-only { display: none; }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .topbar {
      position: fixed;
      z-index: 20;
      inset: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: .85rem clamp(1rem, 3vw, 2.5rem);
      color: #fff;
      mix-blend-mode: difference;
      pointer-events: none;
    }
    .topbar-title {
      max-width: min(70vw, 34rem);
      overflow: hidden;
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .12em;
      line-height: 1.2;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .topbar button, .topbar a, .return-button, .copy-button {
      border: 1px solid currentColor;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: .7rem;
      font-weight: 700;
      letter-spacing: .08em;
      padding: .55rem .8rem;
      text-decoration: none;
      text-transform: uppercase;
      transition: background-color 140ms ease, color 140ms ease, transform 100ms ease;
    }
    .topbar button { pointer-events: auto; }
    .topbar button:hover, .topbar button:focus-visible, .return-button:hover, .return-button:focus-visible, .copy-button:hover, .copy-button:focus-visible {
      background: currentColor;
      color: var(--ink);
    }
    button:active, a:active { transform: scale(.97); }
    button:focus-visible, a:focus-visible {
      outline: 3px solid #f6d64a;
      outline-offset: 3px;
    }

    .presentation-view { height: 100dvh; }
    .slides-track {
      display: flex;
      width: 100%;
      height: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
    }
    .slides-track::-webkit-scrollbar { display: none; }
    .slide {
      position: relative;
      display: flex;
      flex: 0 0 100vw;
      width: 100vw;
      height: 100dvh;
      min-height: 0;
      overflow: hidden;
      scroll-snap-align: start;
      scroll-snap-stop: always;
    }
    .slide-inner {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(12rem, .6fr);
      align-items: end;
      gap: clamp(1.5rem, 7vw, 8rem);
      width: min(100%, 100rem);
      height: 100%;
      margin: 0 auto;
      padding: clamp(5rem, 12vh, 8rem) clamp(1.25rem, 7vw, 8rem) clamp(2.5rem, 8vh, 5rem);
    }
    .slide-copy { min-width: 0; max-height: 72dvh; overflow: hidden; }
    .slide-eyebrow {
      margin: 0 0 1.25rem;
      font-size: .72rem;
      font-weight: 800;
      letter-spacing: .16em;
      opacity: .7;
      text-transform: uppercase;
    }
    .slide h2 {
      max-width: 12ch;
      margin: 0;
      font-size: clamp(3.25rem, 8.2vw, 9rem);
      font-weight: 650;
      letter-spacing: -.075em;
      line-height: .88;
      text-wrap: balance;
    }
    .slide-body {
      max-width: 42rem;
      margin-top: clamp(1.5rem, 4vh, 3rem);
      font-size: clamp(1rem, 1.4vw, 1.35rem);
      line-height: 1.45;
    }
    .slide-body p { margin: 0 0 .9em; }
    .slide-body p:last-child { margin-bottom: 0; }
    .slide-body strong { font-weight: 800; }
    .slide-body a { color: inherit; text-underline-offset: .15em; }
    .slide-stat { align-self: center; }
    .stat-value {
      margin: 0;
      font-size: clamp(6.5rem, 15vw, 11rem);
      font-weight: 700;
      letter-spacing: -.1em;
      line-height: .8;
      overflow-wrap: anywhere;
    }
    .stat-label {
      max-width: 15rem;
      margin: 1.25rem 0 0;
      font-size: .9rem;
      font-weight: 700;
      letter-spacing: .04em;
      line-height: 1.25;
      text-transform: uppercase;
    }
    .slide-number {
      position: absolute;
      right: clamp(1.25rem, 7vw, 8rem);
      bottom: 1.5rem;
      font-size: .7rem;
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      letter-spacing: .12em;
      opacity: .6;
    }
    .theme-ink { background: var(--ink); color: #f5f1e8; }
    .theme-paper { background: var(--paper); color: var(--ink); }
    .theme-sand { background: var(--sand); color: var(--ink); }
    .theme-blue { background: var(--blue); color: #f4f1ea; }
    .theme-red { background: var(--red); color: #fff5ed; }

    .dot-nav {
      position: fixed;
      z-index: 15;
      right: clamp(1rem, 2.5vw, 2rem);
      bottom: 1.5rem;
      display: flex;
      gap: .45rem;
      align-items: center;
      padding: .45rem .6rem;
      border: 1px solid rgb(255 255 255 / 28%);
      border-radius: 999px;
      background: rgb(0 0 0 / 22%);
      backdrop-filter: blur(8px);
    }
    .dot {
      width: .45rem;
      height: .45rem;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: rgb(255 255 255 / 48%);
      cursor: pointer;
    }
    .dot[aria-current="true"] { width: .8rem; border-radius: 999px; background: #fff; }

    .formats-view {
      display: block;
      height: 100dvh;
      overflow: auto;
      padding: clamp(5rem, 10vh, 8rem) clamp(1rem, 7vw, 8rem) 5rem;
      background: var(--paper);
      color: var(--ink);
    }
    .formats-shell { width: min(100%, 74rem); margin: 0 auto; }
    .formats-header { display: flex; justify-content: space-between; align-items: end; gap: 2rem; margin-bottom: 2.5rem; }
    .formats-header h1 { max-width: 12ch; margin: 0; font-size: clamp(3rem, 8vw, 7rem); letter-spacing: -.08em; line-height: .85; }
    .formats-header p { max-width: 30rem; margin: 0; color: rgb(23 23 23 / 65%); line-height: 1.5; }
    .format-tabs { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 2rem; }
    .format-tab { border: 1px solid var(--line); border-radius: 999px; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: .7rem 1rem; transition: background-color 140ms ease, color 140ms ease, transform 100ms ease; }
    .format-tab[aria-selected="true"] { border-color: var(--ink); background: var(--ink); color: var(--paper); }
    .format-panel { max-width: 60rem; padding: clamp(1.25rem, 3vw, 2.5rem); border-top: 1px solid var(--line); }
    body.js-ready .format-panel:not(.active) { display: none; }
    .format-panel h2 { margin: 0 0 1.25rem; font-size: clamp(1.7rem, 3vw, 2.6rem); letter-spacing: -.05em; }
    .format-content { max-width: 50rem; font-size: 1.05rem; line-height: 1.65; }
    .format-content > :first-child { margin-top: 0; }
    .format-content pre { overflow-x: auto; padding: 1rem; background: #e7e1d7; font-size: .9rem; }
    .format-content code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .9em; }
    .format-content a { color: inherit; text-underline-offset: .15em; }
    .format-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin: 0 0 1.5rem; }
    .copy-button { border-color: var(--ink); }
    .copy-button:hover, .copy-button:focus-visible { background: var(--ink); color: var(--paper); }
    .return-button { display: inline-flex; border-color: var(--ink); color: var(--ink); }
    .copy-status { min-height: 1.5em; margin: 1rem 0 0; color: rgb(23 23 23 / 68%); font-size: .85rem; }

    @media (max-width: 700px) {
      .slide-inner { display: block; padding-top: 6rem; }
      .slide-copy { max-height: 75dvh; }
      .slide h2 { max-width: 10ch; font-size: clamp(3.2rem, 16vw, 6rem); }
      .slide-stat { position: absolute; right: 1.25rem; bottom: 5.5rem; max-width: 44vw; }
      .stat-value { font-size: clamp(4.5rem, 19vw, 8rem); }
      .stat-label { margin-top: .8rem; font-size: .72rem; }
      .formats-header { display: block; }
      .formats-header p { margin-top: 1.5rem; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
    }
  </style>
</head>
<body>
  <header class="topbar" role="banner">
    <div class="topbar-title">${title}</div>
    <button type="button" data-action="formats" aria-controls="formats-view" aria-expanded="false">Formatos</button>
  </header>

  <main>
    <section id="presentation-view" class="presentation-view" aria-labelledby="presentation-heading">
      <h1 id="presentation-heading" class="sr-only">${title}</h1>
      <div class="slides-track" tabindex="0" role="region" aria-label="Apresentação com 10 slides">
${slidesHtml}
      </div>
      <nav class="dot-nav" aria-label="Navegação dos slides">
${dotsHtml}
      </nav>
    </section>

    <section id="formats-view" class="formats-view" aria-labelledby="formats-heading">
      <div class="formats-shell">
        <div class="formats-header">
          <div>
            <p class="slide-eyebrow">Conteúdo pronto a usar</p>
            <h1 id="formats-heading">Formatos</h1>
          </div>
          <div>
            <p>${description}</p>
            <a class="return-button no-js-only" href="#presentation-view">Apresentação</a>
            <button class="return-button" type="button" data-action="presentation">Apresentação</button>
          </div>
        </div>
        <nav class="format-tabs" role="tablist" aria-label="Formatos de conteúdo">
${tabsHtml}
        </nav>
        <div class="format-panels">
${formatsHtml}
        </div>
        <p id="copy-status" class="copy-status" role="status" aria-live="polite"></p>
      </div>
    </section>
  </main>

  <script>
    (() => {
      const data = ${serializedData};
      const body = document.body;
      const track = document.querySelector('.slides-track');
      const slides = Array.from(document.querySelectorAll('.slide'));
      const dots = Array.from(document.querySelectorAll('.dot'));
      const formatsView = document.getElementById('formats-view');
      const status = document.getElementById('copy-status');
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let currentSlide = 0;

      body.classList.add('js-ready');
      document.getElementById('presentation-view')?.setAttribute('aria-hidden', 'false');
      formatsView?.setAttribute('aria-hidden', 'true');

      function setMode(mode) {
        const formatsMode = mode === 'formats';
        body.classList.toggle('formats-mode', formatsMode);
        document.querySelector('[data-action="formats"]')?.setAttribute('aria-expanded', String(formatsMode));
        document.getElementById('presentation-view')?.setAttribute('aria-hidden', String(formatsMode));
        formatsView?.setAttribute('aria-hidden', String(!formatsMode));
        if (formatsMode) formatsView?.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      }

      function setCurrentSlide(index) {
        currentSlide = Math.max(0, Math.min(index, slides.length - 1));
        dots.forEach((dot, dotIndex) => dot.setAttribute('aria-current', String(dotIndex === currentSlide)));
      }

      function goToSlide(index) {
        setCurrentSlide(index);
        track?.scrollTo({ left: currentSlide * (track.clientWidth || window.innerWidth), behavior: reducedMotion ? 'auto' : 'smooth' });
      }

      dots.forEach((dot) => dot.addEventListener('click', () => {
        const index = Number(dot.dataset.slideIndex);
        if (Number.isInteger(index)) goToSlide(index);
      }));

      if (track && 'IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.55) {
              const index = slides.indexOf(entry.target);
              if (index >= 0) setCurrentSlide(index);
            }
          });
        }, { root: track, threshold: [0.55] });
        slides.forEach((slide) => observer.observe(slide));
      }

      document.querySelectorAll('[data-action="formats"]').forEach((control) => control.addEventListener('click', (event) => {
        event.preventDefault();
        setMode('formats');
        document.querySelector('.format-tab')?.focus({ preventScroll: true });
      }));
      document.querySelectorAll('[data-action="presentation"]').forEach((control) => control.addEventListener('click', (event) => {
        event.preventDefault();
        setMode('presentation');
        track?.focus({ preventScroll: true });
      }));

      const formatTabs = Array.from(document.querySelectorAll('.format-tab'));

      function activateFormat(formatId) {
        formatTabs.forEach((tab) => {
          const selected = tab.dataset.formatId === formatId;
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
        });
        document.querySelectorAll('.format-panel').forEach((panel) => {
          const active = panel.dataset.formatId === formatId;
          panel.classList.toggle('active', active);
          panel.setAttribute('aria-hidden', String(!active));
        });
      }

      formatTabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
          if (tab.dataset.formatId) activateFormat(tab.dataset.formatId);
        });
        tab.addEventListener('keydown', (event) => {
          let nextIndex = null;
          if (event.key === 'ArrowLeft') nextIndex = (index - 1 + formatTabs.length) % formatTabs.length;
          if (event.key === 'ArrowRight') nextIndex = (index + 1) % formatTabs.length;
          if (event.key === 'Home') nextIndex = 0;
          if (event.key === 'End') nextIndex = formatTabs.length - 1;
          if (nextIndex === null) return;
          event.preventDefault();
          const nextTab = formatTabs[nextIndex];
          if (nextTab?.dataset.formatId) activateFormat(nextTab.dataset.formatId);
          nextTab?.focus();
        });
      });
      activateFormat(data.formats[0].id);

      async function copyPayload(formatId, kind) {
        const format = data.formats.find((candidate) => candidate.id === formatId);
        if (!format) return;
        const plainText = format.plainText;
        const richHtml = format.richHtml;
        try {
          if (kind === 'rich' && navigator.clipboard?.write && window.ClipboardItem) {
            const item = new ClipboardItem({
              'text/html': new Blob([richHtml], { type: 'text/html' }),
              'text/plain': new Blob([plainText], { type: 'text/plain' })
            });
            await navigator.clipboard.write([item]);
          } else if (kind === 'rich') {
            fallbackCopy(richHtml, true);
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(plainText);
          } else {
            fallbackCopy(plainText, false);
          }
          if (status) status.textContent = kind === 'rich' ? 'Rich text copiado.' : 'Texto copiado.';
        } catch (_error) {
          try {
            if (kind === 'rich') {
              if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(plainText);
              else fallbackCopy(plainText, false);
              if (status) status.textContent = 'Rich text indisponível; texto simples copiado.';
            } else {
              fallbackCopy(plainText, false);
              if (status) status.textContent = 'Texto copiado.';
            }
          } catch (_fallbackError) {
            if (status) status.textContent = 'Não foi possível copiar. Seleciona o conteúdo manualmente.';
          }
        }
      }

      function fallbackCopy(value, rich) {
        const node = rich ? document.createElement('div') : document.createElement('textarea');
        if (rich) node.innerHTML = value;
        else node.value = value;
        node.setAttribute('readonly', '');
        node.style.position = 'fixed';
        node.style.opacity = '0';
        document.body.appendChild(node);
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(node);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (node instanceof HTMLTextAreaElement) node.select();
        const copied = document.execCommand('copy');
        selection?.removeAllRanges();
        node.remove();
        if (!copied) throw new Error('Copy command failed');
      }

      document.querySelectorAll('[data-copy-kind]').forEach((button) => button.addEventListener('click', () => {
        const formatId = button.dataset.formatId;
        const kind = button.dataset.copyKind;
        if (formatId && kind) void copyPayload(formatId, kind);
      }));

      function isInteractiveElement(element) {
        return element instanceof HTMLElement && element.matches('a, button, input, textarea, select, summary, [contenteditable="true"], [role="button"], [role="tab"]');
      }

      document.addEventListener('keydown', (event) => {
        if (isInteractiveElement(document.activeElement)) return;
        if (event.key === 'Escape' && body.classList.contains('formats-mode')) {
          event.preventDefault();
          setMode('presentation');
          track?.focus({ preventScroll: true });
          return;
        }
        if (body.classList.contains('formats-mode')) return;
        if (event.key === 'ArrowLeft') { event.preventDefault(); goToSlide(currentSlide - 1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); goToSlide(currentSlide + 1); }
        if (event.key === 'Home') { event.preventDefault(); goToSlide(0); }
        if (event.key === 'End') { event.preventDefault(); goToSlide(slides.length - 1); }
      });
    })();
  </script>
</body>
</html>
`;
}

function renderSlide(slide: EditorialHtmlData["slides"][number], index: number): string {
  const stat = slide.stat
    ? `<div class="slide-stat" aria-label="${escapeHtml(slide.stat.value)}: ${escapeHtml(slide.stat.label)}"><p class="stat-value" aria-hidden="true">${escapeHtml(slide.stat.value)}</p><p class="stat-label">${escapeHtml(slide.stat.label)}</p></div>`
    : "";
  return `        <article id="slide-${escapeHtml(slide.id)}" class="slide theme-${escapeHtml(slide.theme)}" data-slide-index="${index}" aria-labelledby="slide-title-${escapeHtml(slide.id)}">
          <div class="slide-inner">
            <div class="slide-copy">
              <p class="slide-eyebrow">${escapeHtml(slide.eyebrow)}</p>
              <h2 id="slide-title-${escapeHtml(slide.id)}">${escapeHtml(slide.title)}</h2>
              <div class="slide-body">${slide.bodyHtml}</div>
            </div>
            ${stat}
          </div>
          <span class="slide-number" aria-hidden="true">${String(index + 1).padStart(2, "0")} / 10</span>
        </article>`;
}

function renderFormatPanel(format: RenderedFormat): string {
  const richButton = format.id === "blog" || format.id === "newsletter"
    ? `<button class="copy-button" type="button" data-copy-kind="rich" data-format-id="${escapeHtml(format.id)}">Copiar rich text</button>`
    : "";
  return `          <article id="format-${escapeHtml(format.id)}" class="format-panel${format.id === "blog" ? " active" : ""}" data-format-id="${escapeHtml(format.id)}" role="tabpanel" aria-labelledby="tab-${escapeHtml(format.id)}" aria-hidden="${format.id === "blog" ? "false" : "true"}">
            <h2>${escapeHtml(format.label)}</h2>
            <div class="format-actions">
              <button class="copy-button" type="button" data-copy-kind="plain" data-format-id="${escapeHtml(format.id)}">Copiar texto</button>
              ${richButton}
            </div>
            <div class="format-content">${format.richHtml}</div>
          </article>`;
}

function renderMarkdown(markdown: string): string {
  const parsed = marked.parse(markdown, { async: false, gfm: true, breaks: false });
  if (typeof parsed !== "string") throw new Error("Markdown renderer returned an asynchronous result");
  return sanitizeHtml(parsed, SANITIZE_OPTIONS);
}

function markdownToPlainText(renderedHtml: string): string {
  const withVisibleLinks = renderedHtml.replace(
    /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu,
    (_match: string, href: string, label: string) => `${label.replace(/<[^>]*>/gu, "")} (${href})`,
  );
  const withLineBreaks = withVisibleLinks
    .replace(/<br\s*\/?>(\n)?/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n• ")
    .replace(/<blockquote\b[^>]*>/giu, "\n> ")
    .replace(/<\/(?:p|h[1-6]|li|blockquote|pre|ul|ol|hr|div)>/giu, "\n");
  const withoutTags = withLineBreaks.replace(/<[^>]*>/gu, "");
  const decoded = decodeHtmlEntities(withoutTags);
  const plain = decoded
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return plain;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(x[\da-f]+|\d+);/giu, (_match, code: string) => {
      const parsed = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isSafeInteger(parsed) ? String.fromCodePoint(parsed) : _match;
    })
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/giu, (entity) => {
      const entities: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
      };
      return entities[entity.toLowerCase()] ?? entity;
    });
}

function getMarkdown(markdownByPath: ReadonlyMap<string, string>, key: string, fallback: string): string {
  const markdown = markdownByPath.get(key);
  if (markdown === undefined) throw new Error(`Missing loaded Markdown for ${key}`);
  return markdown || fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003C")
    .replace(/>/gu, "\\u003E")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}
