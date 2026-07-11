# Blog publish check

O `blog publish check` corre depois de o post estar escrito e antes de publicar.

Objectivo: apanhar exagero factual, estrutura fraca, metadata incompleta e SEO
basico em falta. Nao reescrever o artigo inteiro. Produzir uma lista curta de
fixes priorizados.

## Ordem do check

```txt
1. Source / claim gate
2. Estrutura editorial
3. Metadata de publicacao
4. Links e media
5. SEO leve
6. Relatorio final
```

## 1. Source / claim gate

Bloquear publicacao se:

- ha menos de 3 fontes uteis para diagnostico
- ha menos de 4 fontes em temas de privacidade, copyright, seguranca, legal,
  financas, benchmarks ou superlativos
- numeros, datas, benchmarks ou claims legais aparecem sem link
- uma inferencia esta escrita como facto
- uma fonte de marketing prova uma claim mais forte do que a fonte permite
- o post removeu os riscos ou claims a nao exagerar vindos do `diagnose`

Resultado esperado:

```md
## Source / claim gate

Status: PASS | WARN | FAIL

- Factos seguros:
- Inferencias:
- Hipoteses:
- Claims a corrigir:
```

## 2. Estrutura editorial

Verificar:

- o titulo promete a tese real do texto
- a primeira seccao explica o sinal sem contexto generico
- existe uma tese principal clara
- existe pelo menos uma contradicao ou detalhe estranho
- existe uma consequencia pratica
- os subtitulos ajudam skimming
- o fim nao introduz claims novos
- o tom nao usa pose, press release ou hype

## 3. Metadata de publicacao

Frontmatter minimo:

```yaml
title:
description:
slug:
format:
tags:
sources:
confidence:
```

Campos opcionais quando aplicavel:

```yaml
date:
updated:
author:
canonical:
hero_image:
hero_alt:
og_title:
og_description:
social_teaser:
```

Checks:

- `title` ate 70 caracteres quando possivel
- `description` com 120-160 caracteres quando possivel
- `slug` curto, em lowercase, com hifens e sem data
- `canonical` presente se o texto tambem existir noutro sitio
- `confidence` alinhado com o material de origem

## 4. Links e media

Verificar:

- links externos apontam para a fonte de origem quando possivel
- links internos existem quando houver posts relacionados
- texto ancora descreve o destino, sem "clica aqui"
- imagens tem `alt` util
- screenshots, charts ou embeds nao carregam a prova sozinhos; claims continuam
  escritos e linkados no texto

## 5. SEO leve

SEO nao deve mandar na tese. Deve tornar o texto publicavel.

Verificar:

- H1 unico
- H2s em ordem logica
- titulo, description e slug dizem a mesma promessa
- primeiro paragrafo deixa claro o tema
- nao ha keyword stuffing
- nao ha titulo clickbait que o texto nao paga
- teaser social funciona sem depender de contexto escondido

## 6. Relatorio final

Usar este formato:

```md
## Blog Publish Check: [title]

**File**: [path]
**Overall**: PASS | WARN | FAIL

### Results

| Check | Status | Details | Fix |
| --- | --- | --- | --- |
| Source / claim gate | PASS | ... | - |
| Editorial structure | WARN | ... | ... |
| Metadata | PASS | ... | - |
| Links / media | WARN | ... | ... |
| SEO leve | PASS | ... | - |

### Priority fixes

1. ...
2. ...
3. ...

### Claims a nao exagerar

- ...
```

## Status

- `PASS`: pode publicar depois de pequenas correccoes editoriais.
- `WARN`: publicavel so depois dos fixes listados.
- `FAIL`: nao publicar; falta chao factual ou ha claims perigosas.
