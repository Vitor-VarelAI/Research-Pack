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

## Alteração preparada para teste

Commit: `refine: add deterministic anti-slop gate`.

- `src/editorial/prompts.ts`: a geração recebe um brief positivo de voz, sem catálogo
  de frases proibidas. Ângulos, diagnóstico, draft e QA recebem os factos estruturados
  do research pack sem `anchors[].text`, para não copiar a cadência das fontes.
- `src/editorial/no-ai-slop.ts`: scanner determinístico para contrastes binários,
  falsas revelações, kickers genéricos, cadeias de citações, tratamento formal,
  conectores vazios e travessões.
- `src/editorial/run-editorial-job.ts`: o scanner corre antes das duas chamadas
  DeepSeek de QA. Uma violação gera `HOLD`, preserva draft/formatos para inspeção e
  evita gastar as duas chamadas de QA.
- `tests/editorial-core.test.ts`: cobre deteção e texto limpo, remoção da prosa bruta
  dos prompts, separação entre brief positivo e regras negativas, bloqueio local sem
  chamadas ao provider e o caminho limpo com exatamente duas chamadas QA.

Arquitetura:

```text
fontes e factos estruturados
  -> geração com brief positivo de voz
  -> scan determinístico anti-slop
  -> QA DeepSeek, apenas se o scan local passar
  -> aprovação humana
```

O catálogo negativo fica no scanner e no QA. Não é colocado no prompt de geração,
porque repetir fórmulas proibidas ao modelo também as pode ensinar.

## Validação local

```text
git diff --check: passou
node --import tsx --test tests/editorial-core.test.ts: 34 testes passaram
npm run typecheck: passou
npm test: 170 testes passaram
npm run build: passou
```

Não foi executado nenhum job editorial pago nesta sessão.

## Teste seguinte

Criar um job real pela UI e observar o draft e os formatos. O antigo job Kimi K3
`job_a923c908-d8f3-41f4-b5dc-a7bce8824927` contém exemplos úteis de regressão para
comparação:

```text
A pergunta que fica não é X. A pergunta é Y.
Já não é um chatbot. É um trabalhador autónomo.
O verdadeiro debate está para vir.
```

Resultado esperado:

1. A geração deve aproximar-se da referência antiga sem copiar a estrutura das fontes.
2. Se uma fórmula detetável sobreviver, o job deve parar em QA com `HOLD` e uma
   violação `[no-ai-slop:<regra>]`.
3. Se o scan local passar, continuam a existir exatamente duas chamadas DeepSeek de
   QA antes da aprovação humana.

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
