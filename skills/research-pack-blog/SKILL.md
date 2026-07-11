---
name: research-pack-blog
description: Turn Research Pack project outputs into publishable blog posts, newsletter dispatches, evergreen web posts, or pre-publish checks. Use when the user asks to convert a research pack or diagnose into a blog/article/newsletter draft, add blog formats, run a blog publish check, validate SEO metadata, or adapt editorial output from profiles/editorial/research-pack.md and profiles/editorial/diagnose.md.
---

# Research Pack Blog

## Overview

Use this skill inside the Research Pack repo. Treat the project profiles as the
source of truth:

- `profiles/editorial/research-pack.md`: factual source material
- `profiles/editorial/diagnose.md`: strategic reading
- `profiles/editorial/blog-post.md`: final post formats
- `profiles/editorial/blog-publish-check.md`: pre-publish gate

## Workflow

1. Read the user's target artifact: a research pack, a diagnose, or a draft
   post.
2. If writing a post, read `profiles/editorial/blog-post.md` and choose one
   format: `diagnostico-curto`, `web-post-evergreen`,
   `newsletter-dispatch`, or `brief-operacional`.
3. If checking a post, read `profiles/editorial/blog-publish-check.md` and
   produce the requested PASS/WARN/FAIL report.
4. Preserve the source hierarchy: fact, inference, editorial hypothesis, weak
   speculation.
5. Do not introduce new claims while drafting. If the input lacks factual
   support, mark the gap instead of filling it from memory.

## Guardrails

- Keep PT-PT unless the user asks otherwise.
- Keep the blog layer additive; do not rewrite `research-pack.md` or
  `diagnose.md` unless explicitly requested.
- Never turn marketing language into independent fact.
- For privacy, copyright, security, legal, finance, benchmarks or superlatives,
  require a fourth useful source before confident diagnosis.
- For worker review in this project, use pi workers and project-approved models
  only.
