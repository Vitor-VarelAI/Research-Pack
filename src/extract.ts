import { ArticleExtractionSchema, type ArticleExtraction } from "./schemas/article.js";
import type { ScrapedDocument } from "./types.js";

export type BuiltInSchemaName = "article";

export function extractBuiltIn(schemaName: BuiltInSchemaName, document: ScrapedDocument): ArticleExtraction {
  switch (schemaName) {
    case "article": {
      const markdown = document.markdown ?? "";
      const title = document.title ?? firstMarkdownHeading(markdown) ?? new URL(document.url).hostname;
      const body = markdown.trim() || document.html?.trim() || "No content extracted.";
      const summary = firstParagraph(markdown);
      return ArticleExtractionSchema.parse({
        title,
        author: null,
        publishedAt: null,
        summary,
        body,
        sourceUrl: document.url,
        evidence: [
          { field: "title", quote: title },
          ...(summary ? [{ field: "summary", quote: summary }] : []),
        ],
      });
    }
  }
}

function firstMarkdownHeading(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function firstParagraph(markdown: string): string | null {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((part) => part.replace(/^#+\s+/gm, "").trim())
    .filter((part) => part.length > 80 && !part.startsWith("!["));
  return paragraphs[0]?.slice(0, 500) ?? null;
}
