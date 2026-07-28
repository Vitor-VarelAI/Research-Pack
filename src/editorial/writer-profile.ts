import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_PROFILE_BYTES = 80_000;

export type WriterProfileLoader = () => Promise<string>;

export type WriterProfileLoaderOptions = {
  privateProfileDir?: string;
  methodFile?: string;
};

export function createWriterProfileLoader(options: WriterProfileLoaderOptions = {}): WriterProfileLoader {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= loadWriterProfile(options);
    return cached;
  };
}

async function loadWriterProfile(options: WriterProfileLoaderOptions): Promise<string> {
  const sections: string[] = [];
  if (options.privateProfileDir?.trim()) {
    for (const name of ["voice.md", "soul.md"]) {
      const content = await readOptionalBounded(path.join(path.resolve(options.privateProfileDir), name));
      if (content) sections.push(curatePrivateProfile(name, content));
    }
  }
  const methodFile = path.resolve(options.methodFile ?? "profiles/editorial/blog-post.md");
  const method = await readOptionalBounded(methodFile);
  if (method) sections.push(method);
  return sections.join("\n\n").trim();
}

function curatePrivateProfile(name: string, value: string): string {
  if (name === "voice.md") return value.split("\nExemplos de tom:")[0]!.trim();
  if (name === "soul.md") return value.split("\n## Voice / como eu falo")[0]!.trim();
  return value.trim();
}

async function readOptionalBounded(file: string): Promise<string> {
  try {
    const value = await readFile(file, "utf8");
    return Buffer.from(value, "utf8").subarray(0, MAX_PROFILE_BYTES).toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
