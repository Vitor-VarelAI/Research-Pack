# Handoff — feat/visual-cockpit (voz editorial + correções do cockpit)

Sessão de 2026-07-27. Branch `feat/visual-cockpit`. Atualizado pelo agente Claude.

## Objetivo da sessão

Ligar a UI do cockpit ao backend editorial e afinar a voz editorial para diagnóstico
estratégico (não "notícia de jornal"). Base inicial: `53cc91a`.

## O que foi feito (commits, mais recente primeiro)

| Commit | O quê | Porquê |
| --- | --- | --- |
| `53b7fb9` | refine: tratar o leitor por "tu" na voz editorial | Draft saía em "você/lhe" (formal); fixado 2ª pessoa singular |
| `5197948` | refine: voz mais coloquial; banir abertura em ficha de specs e cadeias de citação | Texto ainda soava técnico: abria por specs e encadeava (BBC, Reuters, CNBC) |
| `91fad06` | fix: navegação de package converge para o job completed mais recente | Cockpit fazia reload infinito a saltar entre dois pacotes |
| `d1bab28` | fix: rejeitar URLs de busca/agregador na descoberta de âncoras | Research metia links de pesquisa (hn.algolia.com/?query=) como âncora → source gate falhava sempre com 2 |
| `f554bfc` | feat: injetar voz editorial na geração e no QA | Prompts de voz existiam mas estavam desligados do runtime; draft saía como jornal |

## Causas-raiz confirmadas (com evidência)

1. **Voz de jornal** — `EDITORIAL_SYSTEM_PROMPT` (`src/editorial/prompts.ts`) só dizia
   "cumpre o JSON". Os docs de voz (`prompts/*.md`, `profiles/editorial/*.md`) só eram
   usados por scripts `.sh` offline, nunca no runtime. Corrigido com a constante
   `EDITORIAL_VOICE`, injetada em draft, formatos e nos dois QA.
2. **Source gate falhava sempre** — `isLikelyNavigationOrPolicyUrl`
   (`src/editorial/run-editorial-job.ts`) não filtrava URLs de busca. Um link
   `hn.algolia.com/?query=...` ocupava um slot de descoberta, não gerava claims, era
   descartado pelo gate → ficavam 2 âncoras (< 3 exigidas). Filtro estendido para hosts
   de busca/agregador e formas `?query=`/`?q=`/`/search`.
3. **Reload infinito** — a navegação `?package=` estava dentro de `renderJob` (corre por
   cada job). Com dois jobs `completed`, cada um impunha o seu slug ao URL. Movido para
   `renderJobs`, alvo único = job completed mais recente.

## Estado atual

- Serviço `scrape-agent-cockpit.service` (systemd --user): `active`, HTTPS 200 em
  `https://vmi3305438.tail917695.ts.net:10000/`.
- `npm run typecheck` / `npm test` (167 testes) / `npm run build`: todos a passar.
- Pacote de validação publicado com a voz nova:
  `data/editorial/a-carta-dos-pesos-abertos-que-duplicou-em-24-horas-e-o-que-esconde/`
  (job Forbes/Huang open-weights; 5 âncoras, 10 slides, QA aprovado).

## Arquitetura da voz (para próximos ajustes)

- Fonte única de verdade em runtime: constante `EDITORIAL_VOICE` em
  `src/editorial/prompts.ts`. É interpolada em `EDITORIAL_SYSTEM_PROMPT` e nos builders
  de draft/formatos/QA. Ajustar a voz = editar esta constante (não os `.md`).
- Os `.md` em `prompts/` e `profiles/editorial/` continuam como doc/scripts offline.
- O QA runtime (`buildEditorialQaPrompt`/`buildFormatsQaPrompt`) é bloqueante e agora
  reprova voz de jornal/slop.

## Como correr um job por API (sem CLI)

Requer CSRF: header `X-CSRF-Token` (do `<meta name="csrf-token">` da página),
`Origin` exato e `Sec-Fetch-Site: same-origin`. POST `/api/jobs` para criar,
`/api/jobs/<id>/select-angle`, `/api/jobs/<id>/approve`. Cada job novo é chamada paga
(Firecrawl + DeepSeek); aprovação é só promoção (sem custo).

## Pendente

- Push dos commits locais para `origin/feat/visual-cockpit`.
- Decisão do Vitor: a voz com "tu" ainda não foi vista num job novo (o pacote Forbes é
  anterior ao commit `53b7fb9`). Confirmar com novo job pago ou aceitar como está.
