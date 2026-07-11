# Blog post

O `blog post` e a saida final para publicar. Ele vem depois de:

```txt
research pack -> diagnose -> blog post
```

Nao deve descobrir factos novos enquanto escreve. Se faltar chao factual, volta ao
`research pack` ou marca a lacuna. A escrita so pode usar factos, inferencias,
hipoteses e riscos que ja estejam separados no material de entrada.

## Entrada esperada

Usar o `diagnose` como fonte principal:

- tese principal
- 3-5 factos seguros
- 1 contradicao forte
- 1 consequencia pratica
- 1 angulo recomendado
- riscos / claims a nao exagerar

Usar o `research pack` apenas para confirmar fontes, contexto e grau de
confianca.

## Escolha de formato

Antes de escrever, escolher um formato. Nao misturar formatos na mesma peca.

### Diagnostico curto

Usar para noticia recente, lancamento, movimento competitivo ou mudanca de
plataforma.

Tamanho: 600-900 palavras.

Estrutura:

```md
---
title:
description:
slug:
format: diagnostico-curto
tags:
sources:
confidence:
---

# [Titulo]

## O sinal
O que aconteceu e porque interessa agora.

## O chao
3-5 factos seguros, com links proximos dos claims.

## A jogada
A tese principal em linguagem simples.

## A parte estranha
A contradicao que revela o incentivo.

## O que muda
Uma consequencia pratica para workflow, distribuicao, dinheiro ou poder.

## O que nao sabemos
Claims frageis, limites da leitura e riscos de exagero.
```

### Web post evergreen

Usar para uma tese duravel, explicador, framework ou post que deve continuar
util meses depois.

Tamanho: 1000-1800 palavras.

Estrutura:

```md
---
title:
description:
slug:
format: web-post-evergreen
tags:
sources:
confidence:
canonical:
---

# [Titulo]

## A tese
Declarar a leitura sem pose.

## Porque isto existe agora
Timing e incentivo.

## O mecanismo
Distribuicao, dinheiro, dependencia, custo, lock-in ou workflow.

## O exemplo concreto
Usar 2-4 factos confirmados para mostrar o mecanismo.

## Onde a leitura pode falhar
Separar limite factual, inferencia e especulacao.

## O takeaway
A frase pratica que o leitor deve levar.
```

### Newsletter dispatch

Usar para email/newsletter: mais directo, mais pessoal, menos enciclopedico.

Tamanho: 700-1200 palavras.

Estrutura:

```md
---
subject:
preview:
title:
format: newsletter-dispatch
tags:
sources:
confidence:
---

# [Titulo]

## Abertura
2-4 frases. O que aconteceu, porque estou a olhar para isto, e a pergunta.

## O detalhe util
O facto ou contradicao que muda a leitura.

## A leitura
A tese, com cuidado para nao vender certeza onde ha hipotese.

## O impacto pratico
O que muda para quem cria, programa, compra, distribui ou decide.

## Pergunta final
Uma pergunta real para resposta, nao um CTA generico.
```

### Brief operacional

Usar quando o objectivo e transformar a pesquisa numa nota rapida para decisao.

Tamanho: 400-700 palavras.

Estrutura:

```md
---
title:
description:
slug:
format: brief-operacional
tags:
sources:
confidence:
---

# [Titulo]

## Decisao em aberto
Que escolha isto informa.

## Factos seguros
Lista curta, com fonte.

## Leitura provavel
O que parece estar a acontecer.

## Implicacao
O que fazer, monitorizar ou evitar.

## Riscos
O que ainda pode estar errado.
```

## Antes de escrever

Gerar primeiro:

1. 3 titulos possiveis.
2. 2 aberturas possiveis.
3. 1 frase de tese.
4. Formato escolhido e razao.

Depois escrever apenas a versao escolhida.

## Regras de escrita

- Escrever em PT-PT, salvo pedido contrario.
- Usar paragrafos curtos.
- Colocar links perto dos claims que suportam.
- Nao abrir com contexto generico.
- Nao usar "isto muda tudo", "o futuro de", "revolucao", "game-changer" ou
  linguagem de press release.
- Nao esconder incerteza. Usar "o facto e", "a inferencia e", "a hipotese e"
  quando necessario.
- Nao transformar marketing da empresa em facto independente.
- Nao usar estatisticas, benchmarks, datas ou claims legais sem fonte explicita.

## Output minimo

Entregar sempre:

- frontmatter do formato escolhido
- post em markdown
- 2 titulos alternativos
- teaser social de 2-3 frases
- lista "claims a nao exagerar"
