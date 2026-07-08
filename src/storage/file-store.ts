import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord, ScrapedDocument } from "../types.js";
import { safeFileName, writeJson } from "../util.js";

export type FileStore = {
  saveDocument(document: ScrapedDocument): Promise<void>;
  saveExtraction(name: string, value: unknown): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
};

export function createFileStore(rootDir = process.env.SCRAPE_AGENT_DATA_DIR ?? "data"): FileStore {
  const root = path.resolve(rootDir);

  return {
    async saveDocument(document: ScrapedDocument): Promise<void> {
      const name = `${safeFileName(document.url)}-${document.id}`;
      await writeJson(path.join(root, "raw", `${name}.json`), document);
      if (document.markdown) {
        await mkdir(path.join(root, "markdown"), { recursive: true });
        await writeFile(path.join(root, "markdown", `${name}.md`), document.markdown, "utf8");
      }
    },

    async saveExtraction(name: string, value: unknown): Promise<void> {
      await writeJson(path.join(root, "extracted", `${safeFileName(name)}.json`), value);
    },

    async saveRun(record: RunRecord): Promise<void> {
      await mkdir(path.join(root, "runs"), { recursive: true });
      await appendFile(path.join(root, "runs", "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}
