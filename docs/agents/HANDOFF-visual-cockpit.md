# Handoff — feat/visual-cockpit (voz editorial + anti-slop)

Sessão de 2026-07-27. Worktree `/home/vitor/projects/scrape-agent-visual-cockpit`.
Branch `feat/visual-cockpit`.

## Objetivo atual

Usar os exemplos editoriais antigos do Vitor como referência de voz e remover fórmulas
de escrita geradas por AI antes da aprovação. As conversas ditadas pelo Willow Voice
não são a referência principal porque contêm erros de transcrição e de cadência.

Referências privadas, lidas mas não alteradas:

```text
/home/vitor/projects/scrape-agent/profiles/editorial/voice.md
/home/vitor/projects/scrape-agent/profiles/editorial/soul.md
```

Referência externa de padrões: `https://github.com/petergyang/no-ai-slop`.

## Alterações

Commit: `refine: add deterministic anti-slop gate`.

- `src/editorial/prompts.ts`: a geração recebe um brief positivo de voz, sem catálogo
  de frases proibidas. Ângulos, diagnóstico, draft e QA recebem os factos estruturados
  do research pack sem `anchors[].text`, para não copiar a cadência das fontes.
- `src/editorial/no-ai-slop.ts`: scanner determinístico para contrastes binários,
  falsas revelações, kickers genéricos, cadeias de citações, tratamento formal,
  conectores vazios e travessões.
- `src/editorial/run-editorial-job.ts`: o scanner regista as violações junto do QA,
  mas as duas chamadas DeepSeek continuam. Qualquer `HOLD`, `REVIEW` ou `pass=false`
  segue para `awaiting_final_approval`; a decisão final pertence ao Vitor.
- `src/editorial/package-writer.ts`: a aprovação humana pode publicar um pacote com
  alertas de QA. O pacote continua a exigir os dois artefactos estruturados de QA e
  apresenta o resultado como `com alertas para revisão`, não como bloqueio. O staging
  atómico usa agora uma pasta filha com o slug final, para o exportador HTML validar o
  manifest antes da promoção.
- `tests/editorial-core.test.ts`: cobre deteção e texto limpo, remoção da prosa bruta
  dos prompts, separação entre brief positivo e regras negativas, duas chamadas QA
  mesmo com slop e aprovação humana apesar dos alertas.

Arquitetura:

```text
fontes e factos estruturados
  -> geração com brief positivo de voz
  -> scan determinístico anti-slop
  -> QA DeepSeek
  -> alertas editoriais
  -> aprovação ou rejeição humana
```

O catálogo negativo fica no scanner e no QA. Não é colocado no prompt de geração,
porque repetir fórmulas proibidas ao modelo também as pode ensinar.

O source gate factual continua bloqueante antes da escrita. Depois de existirem draft
e formatos válidos, o QA editorial é consultivo e nunca transforma o job em `failed`.

## Validação local

```text
git diff --check: passou
node --import tsx --test tests/editorial-core.test.ts: 34 testes passaram
npm run typecheck: passou
npm test: 171 testes passaram
npm run build: passou
```

O Vitor executou pela UI o job
`job_3ecd71e6-7dde-4064-b072-d65f551fe09d`. A versão anterior parou incorretamente em
QA devido a contrastes binários e um travessão. O draft e os formatos ficaram
persistidos. Não repetir pesquisa, diagnóstico, draft ou formatos.

## Teste seguinte

Depois do deployment, usar `Retry` no job
`job_3ecd71e6-7dde-4064-b072-d65f551fe09d`. O retry parte de QA e reutiliza os
artefactos já pagos. Não iniciar outro job.

Resultado esperado:

1. O retry faz apenas as duas verificações DeepSeek de QA.
2. As violações `[no-ai-slop:<regra>]` aparecem como indicações no cockpit.
3. O job termina em `awaiting_final_approval`, mesmo que o QA tenha `HOLD` ou alertas.
4. O Vitor pode aprovar e gerar o pacote final, ou rejeitar para voltar ao draft.

### Correção da aprovação HTML

O retry já foi concluído e o job está em `awaiting_final_approval`. Duas tentativas de
aprovação falharam porque o package writer exportava HTML dentro de
`.staging-<job>-<uuid>`, enquanto `exportEditorialHtml()` exige que o basename da pasta
seja igual a `publication.slug`. O staging passou a ser
`.staging-<job>-<uuid>/<slug>/`, mantendo a escrita atómica e satisfazendo o contrato
do exportador.

Teste de regressão: aprovação humana com `exportHtml: true`, criação de `index.html` e
transição para `completed`. O próximo clique deve ser apenas `Aprovar`; não repete
Firecrawl, geração ou QA.

## Operação

- Serviço: `scrape-agent-cockpit.service` via `systemctl --user`.
- URL privada: `https://vmi3305438.tail917695.ts.net:10000/`.
- Modelo configurado: `deepseek-v4-flash`.
- O serviço corre `dist/cockpit/server.js` deste worktree.
- Não tocar no Studio em `:443`.

## Histórico relevante

| Commit | Alteração |
| --- | --- |
| `53b7fb9` | Tratar o leitor por `tu` na voz editorial |
| `5197948` | Voz mais coloquial e bloqueio de aberturas técnicas/cadeias de citação |
| `91fad06` | Navegação converge para o package completed mais recente |
| `d1bab28` | Rejeição de URLs de busca/agregador na descoberta de âncoras |
| `f554bfc` | Ligação da voz editorial ao runtime e ao QA |
