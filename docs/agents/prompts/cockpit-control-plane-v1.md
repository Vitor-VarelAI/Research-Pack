# Prompt — Cockpit Control Plane V1

Trabalha em:

```text
/home/vitor/projects/scrape-agent-visual-cockpit
```

Branch inicial:

```text
feat/visual-cockpit
```

Baseline mínima de código:

```text
c2c51b1 Harden visual cockpit read model
```

`c2c51b1` deve ser antepassado de `HEAD`; commits posteriores podem conter apenas este plano e o prompt.

Lê primeiro:

```text
AGENTS.md
docs/plans/cockpit-control-plane-v1.md
docs/agents/PROTOCOL.md
README.md
src/cli.ts
src/cockpit/
src/storage/file-store.ts
scripts/content-qa.sh
```

Objetivo: implementar a V1 do control plane descrita em `docs/plans/cockpit-control-plane-v1.md`, mantendo o produto simples, privado e seguro.

Antes de alterar código, faz um checkpoint curto com:

1. estado Git real;
2. fronteira executável concreta para cada etapa do job;
3. etapas que já existem como código reutilizável;
4. etapas que continuam dependentes de uma sessão interativa;
5. qualquer decisão externa indispensável.

Se não existir um executor não interativo seguro para diagnóstico, draft ou formatos, para e explica o bloqueio. Não inventes um provider, não peças uma API key implicitamente e não ligues o servidor HTTP a Codex, Hermes, `pi` ou qualquer terminal genérico sem decisão explícita de Vitor.

Se a fronteira estiver clara, implementa por esta ordem:

1. schemas e máquina de estados do job;
2. armazenamento atómico em `data/control/jobs`;
3. runner único e comando CLI reutilizável;
4. API pequena e allowlisted;
5. fluxo visual;
6. sandbox systemd e rollout.

Regras de âmbito:

- Um utilizador e um job ativo.
- Polling; não usar WebSockets.
- Ficheiros; não adicionar base de dados.
- Não criar arquitetura de plugins, event bus ou abstrações de providers sem necessidade atual.
- Não alterar o formato dos pacotes editoriais existentes.
- Não remover o exportador HTML.
- Não tocar em providers, pipeline ou `src/cli.ts` além do mínimo exigido pela fronteira partilhada.
- Não permitir shell, comandos, executáveis, argumentos livres ou paths arbitrários vindos do browser.
- Ações mutáveis desligadas por defeito com `SCRAPE_AGENT_COCKPIT_ACTIONS=0`.
- Preservar loopback, Tailscale-only, read-only por defeito e o Studio em `:443`.
- Nunca imprimir ou guardar segredos.
- Não chamar providers pagos nos testes.

Testes mínimos:

- transições válidas e inválidas;
- escrita atómica;
- restart marca `interrupted`;
- exclusão de um segundo job;
- cancelamento e retry;
- validação e limites da API;
- CSRF e same-origin;
- traversal e symlinks;
- nenhum endpoint aceita comandos genéricos;
- compatibilidade com o read model;
- desktop `1440x900`;
- mobile `390x844`;
- zero erros de consola e zero overflow horizontal.

Validação final:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Não faças push, deploy ou alterações ao serviço persistente sem autorização explícita. No final, apresenta:

- ficheiros alterados;
- decisões tomadas;
- testes e resultados;
- riscos residuais;
- estado Git;
- comando exato para revisão local.
