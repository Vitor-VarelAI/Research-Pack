import type { EditorialFormats } from "../schemas/editorial-generation.js";

export type EditorialSlopViolation = {
  rule: "binary_contrast" | "faux_insight" | "colon_reveal" | "rhetorical_setup" | "importance_puffery" | "fake_kicker" | "citation_chain" | "formal_address" | "filler" | "em_dash";
  quote: string;
  why: string;
};

const MAX_VIOLATIONS = 30;

const RULES: ReadonlyArray<{
  rule: EditorialSlopViolation["rule"];
  pattern: RegExp;
  why: string;
}> = [
  {
    rule: "binary_contrast",
    pattern: /\b(?:a pergunta(?: que fica)?|o problema|a história|o debate|o ponto|a questão|isto|isso)?\s*(?:já\s+)?não\s+(?:é|são|foi|eram|está|estão)(?=\s|[,;:.!?]|$)[^.!?\n]{0,180}[.!?]\s*(?:mas\s+)?(?:(?:a pergunta|o problema|a história|o debate|o ponto|a questão)\s+)?(?:é|são|foi|eram|está|estão)(?=\s|[,;:.!?]|$)[^.!?\n]{0,180}/giu,
    why: "Instala um segundo enquadramento através da fórmula «não é X, é Y» em vez de afirmar diretamente o ponto útil.",
  },
  {
    rule: "faux_insight",
    pattern: /\b(?:o que interessa(?: aqui)? é|o verdadeiro (?:problema|debate|gargalo|furo)|a parte que ninguém (?:vê|conta)|a verdade é|a verdadeira questão é)(?=\s|[,;:.!?]|$)[^.!?\n]{0,180}/giu,
    why: "Anuncia profundidade ou exclusividade antes de entregar o mecanismo concreto.",
  },
  {
    rule: "colon_reveal",
    pattern: /(?:^|\n)\s*(?:(?:o detalhe que (?:salta à vista|muda a leitura)|o incentivo\b[^:\n]{0,80}\bé claro|a mudança é concreta)|(?:facto|inferência))\s*:[^\n]{1,220}/gimu,
    why: "Encena uma revelação ou introduz um rótulo editorial em vez de integrar diretamente o facto ou a leitura no texto.",
  },
  {
    rule: "rhetorical_setup",
    pattern: /(?:^|\n)\s*(?:o que fazer|e agora|o que muda)\?\s*[^\n]{1,220}/gimu,
    why: "Faz uma pergunta retórica e responde-lhe de imediato; a recomendação ou consequência pode ser afirmada diretamente.",
  },
  {
    rule: "importance_puffery",
    pattern: /\b(?:a guerra\b[^.!?\n]{0,120}\bestá só a começar|marca um momento (?:decisivo|fundamental|crucial)|sublinha a importância|consolida a sua posição)\b[^.!?\n]{0,120}/giu,
    why: "Aumenta artificialmente a importância do ponto em vez de terminar num facto, consequência ou próximo passo concreto.",
  },
  {
    rule: "fake_kicker",
    pattern: /(?:^|\n)\s*(?:o sinal está dado|o futuro já chegou|quem perceber isto primeiro vai ganhar|o verdadeiro debate está para vir|e isso muda tudo|isto muda tudo)[.!?]?\s*(?=\n|$)/gimu,
    why: "Fecha ou pontua o texto com uma frase de efeito genérica em vez de um ponto concreto.",
  },
  {
    rule: "citation_chain",
    pattern: /\((?:[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][\p{L}\d.&' -]{1,40},\s*)+[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][\p{L}\d.&' -]{1,40}\)/gu,
    why: "Empilha nomes de fontes entre parênteses e faz o texto soar a relatório ou artigo agregado.",
  },
  {
    rule: "formal_address",
    pattern: /(?:^|\n)\s*(?:\d+\.\s*)?(?:Mapeie|Nomeie|Coloque|Peça|Decida|Escreva|Veja|Construa|Faça|Pergunte|Considere|Trate)\b[^.!?\n]{0,180}/gu,
    why: "Trata o leitor pela forma formal em vez da segunda pessoa singular usada pela voz do projeto.",
  },
  {
    rule: "filler",
    pattern: /\b(?:ou seja|importa notar|é importante notar|num mundo onde|no mundo atual|a realidade é|a verdade é)(?=\s|[,;:.!?]|$)[^.!?\n]{0,180}/giu,
    why: "Atrasa o ponto com um conector ou preparação editorial previsível.",
  },
  {
    rule: "em_dash",
    pattern: /[^.\n]{0,100}—[^.\n]{0,100}/gu,
    why: "Usa travessão como apoio automático de ritmo; a copy final deste projeto não usa travessões.",
  },
];

export function detectEditorialSlop(value: string): EditorialSlopViolation[] {
  const violations: EditorialSlopViolation[] = [];
  const seen = new Set<string>();
  for (const { rule, pattern, why } of RULES) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const quote = normalizeQuote(match[0] ?? "");
      if (!quote) continue;
      const key = `${rule}:${quote.toLocaleLowerCase("pt-PT")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ rule, quote, why });
      if (violations.length >= MAX_VIOLATIONS) return violations;
    }
  }
  return violations;
}

export function detectFormatsSlop(formats: EditorialFormats): EditorialSlopViolation[] {
  const sections: Array<[string, string]> = [
    ["newsletter", formats.newsletter],
    ["linkedin", formats.linkedin],
    ["xThread", formats.xThread],
    ["shortVideoIdeas", formats.shortVideoIdeas],
    ["carousel", formats.carousel],
    ["titlesHooks", formats.titlesHooks],
    ...formats.slides.flatMap((slide, index) => [
      [`slide-${index + 1}-title`, slide.title] as [string, string],
      [`slide-${index + 1}-body`, slide.bodyMarkdown] as [string, string],
    ]),
  ];
  return sections.flatMap(([label, text]) => detectEditorialSlop(text).map((violation) => ({
    ...violation,
    quote: `${label}: ${violation.quote}`.slice(0, 300),
  }))).slice(0, MAX_VIOLATIONS);
}

export function formatSlopViolation(violation: EditorialSlopViolation): string {
  return `[no-ai-slop:${violation.rule}] «${violation.quote}»: ${violation.why}`.slice(0, 1_000);
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}
