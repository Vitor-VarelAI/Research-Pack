import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string, seed?: string): string {
  if (!seed) return `${prefix}_${randomUUID()}`;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

export function safeFileName(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "document";
}

/**
 * Write JSON atomically.
 *
 * Serializes the value, writes it to a sibling temporary file, then renames
 * the temp file over the target. Because `rename` is atomic on the same
 * filesystem, a crash or a write failure cannot leave a partial JSON file at
 * `filePath`: either the previous content remains, or the new content is
 * fully in place.
 *
 * If the temp write or rename fails, the temp file is removed (best-effort)
 * and the error is rethrown. The target file is never left with partial
 * content.
 */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}
