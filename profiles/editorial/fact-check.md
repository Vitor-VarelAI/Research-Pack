# Fact check gate

Fact check sits after `SINAL` and before strategic diagnosis.

Workflow order:

```txt
1. SINAL
2. FACT CHECK / FONTES
3. JOGO
4. TIMING
5. DISTRIBUIÇÃO
6. DINHEIRO
7. CONTRADIÇÃO
8. WORKFLOW
9. SEGUNDA ORDEM
10. ÂNGULO
```

Reason: the signal gives the reader context, then the sources anchor the analysis before interpretation grows too far.

## Minimum source rule

Before writing a strategic diagnosis, collect at least 3 anchors:

1. **Official source**  
   Product announcement, company blog, docs, help center, policy page, model page, API docs, changelog.

2. **Independent source**  
   Journalism, analyst note, credible technical write-up, regulatory source, market coverage.

3. **Technical / policy / market source**  
   Paper, benchmark, docs, pricing page, terms, API page, SEC/FTC/EU/regulator page, stock/earnings source, GitHub repo.

If the topic involves privacy, copyright, security, financial claims, benchmarks, or superlatives, add a 4th anchor.

## Anchor format

For each source, write:

```txt
Source:
URL:
Type: official | journalistic | technical | policy | market | other
Confirmed:
- claim anchored by this source
Unconfirmed:
- claim the source does not prove
Interpretation risk:
- where our reading may go beyond the source
```

## Rules

- Cite source of origin when possible, not only aggregators.
- Do not use a source to prove a stronger claim than it actually supports.
- Separate fact from interpretation.
- If a claim depends on marketing language, label it as company claim.
- If a number, date, benchmark, legal claim, privacy claim, or superlative appears, anchor it.
- If fewer than 3 useful links exist, do not pretend confidence. Say what is missing.

## Output block

Use this block in research notes and drafts:

```md
## Fact check / fontes

Antes da leitura estratégica, três âncoras:

1. **[source name]**  
   Link: [url]  
   Confirma: ...  
   Não confirma: ...  
   Risco de interpretação: ...

2. **[source name]**  
   Link: [url]  
   Confirma: ...  
   Não confirma: ...  
   Risco de interpretação: ...

3. **[source name]**  
   Link: [url]  
   Confirma: ...  
   Não confirma: ...  
   Risco de interpretação: ...
```

## Meta / Seedream example

Minimum anchors:

1. TechCrunch on Meta Muse Image.
2. Meta Help Center on images, videos, Vibes, uploads, and edits.
3. Official ByteDance Seedream 5.0 Lite page.

Useful 4th anchor if discussing privacy history:

4. FTC / Meta official source for the 2019 privacy fine or 2021 face recognition shutdown.
