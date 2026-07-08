import { z } from "zod";
import { ArticleExtractionSchema } from "./article.js";
import { FactCheckExtractionSchema } from "./fact-check.js";
import { WebResearchExtractionSchema } from "./web-research.js";

export const BuiltInExtractionSchemas = {
  article: ArticleExtractionSchema,
  "fact-check": FactCheckExtractionSchema,
  "web-research": WebResearchExtractionSchema,
} as const;

export type BuiltInExtractionSchemaName = keyof typeof BuiltInExtractionSchemas;

export function isBuiltInExtractionSchemaName(value: string): value is BuiltInExtractionSchemaName {
  return value in BuiltInExtractionSchemas;
}

export function getBuiltInExtractionSchema(name: BuiltInExtractionSchemaName): z.ZodType {
  return BuiltInExtractionSchemas[name];
}

export function getBuiltInExtractionJsonSchema(name: BuiltInExtractionSchemaName): unknown {
  return stripUnsupportedJsonSchemaKeys(z.toJSONSchema(getBuiltInExtractionSchema(name)));
}

function stripUnsupportedJsonSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsupportedJsonSchemaKeys);
  if (typeof value !== "object" || value === null) return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema") continue;
    cleaned[key] = stripUnsupportedJsonSchemaKeys(child);
  }
  return cleaned;
}

export function parseBuiltInExtraction(name: BuiltInExtractionSchemaName, value: unknown): unknown {
  return getBuiltInExtractionSchema(name).parse(value);
}
