#!/usr/bin/env node
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { buildEditorialHtmlData, renderEditorialHtml } from "./editorial-html.js";
import { PublicationSchema, PUBLICATION_FORMAT_IDS, type Publication } from "./schemas/publication.js";

export type ExportHtmlResult = {
  packageDir: string;
  outputPath: string;
};

export async function exportEditorialHtml(packageDirInput: string): Promise<ExportHtmlResult> {
  if (!packageDirInput || packageDirInput.trim() === "") {
    throw new Error("A package directory is required");
  }

  const packageDir = path.resolve(process.cwd(), packageDirInput);
  await assertDirectoryWithoutSymlinks(packageDir, "package directory");

  const manifestPath = path.join(packageDir, "publication.json");
  await assertRegularFileWithoutSymlinks(manifestPath, packageDir, "publication.json");
  const publication = parsePublication(await readFile(manifestPath, "utf8"));

  if (publication.slug !== path.basename(packageDir)) {
    throw new Error(`Publication slug must match package directory basename: expected ${path.basename(packageDir)}, received ${publication.slug}`);
  }

  const markdownByPath = new Map<string, string>();
  const seenPaths = new Set<string>();
  for (const formatId of PUBLICATION_FORMAT_IDS) {
    const format = publication.formats[formatId];
    const safePath = canonicalMarkdownPath(format.path);
    if (seenPaths.has(safePath)) {
      throw new Error(`Duplicate Markdown path in formats: ${format.path}`);
    }
    seenPaths.add(safePath);
    const markdownPath = path.resolve(packageDir, ...safePath.split("/"));
    await assertRegularFileWithoutSymlinks(markdownPath, packageDir, `format ${formatId}`);
    markdownByPath.set(`format:${formatId}`, await readFile(markdownPath, "utf8"));
  }

  for (const slide of publication.slides) {
    markdownByPath.set(`slide:${slide.id}`, slide.bodyMarkdown);
  }

  const html = renderEditorialHtml(buildEditorialHtmlData(publication, markdownByPath));
  const outputPath = path.join(packageDir, "index.html");
  await writeTextAtomically(outputPath, html);
  return { packageDir, outputPath };
}

async function main(): Promise<void> {
  const packageDir = process.argv[2];
  if (process.argv.length > 3) throw new Error("export:html accepts exactly one package directory");
  const result = await exportEditorialHtml(packageDir ?? "");
  console.log(result.outputPath);
}

function parsePublication(serialized: string): Publication {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(`publication.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return PublicationSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => `${issue.path.join(".") || "publication"}: ${issue.message}`).join("; ");
      throw new Error(`Invalid publication.json: ${details}`);
    }
    throw error;
  }
}

async function assertDirectoryWithoutSymlinks(directoryPath: string, description: string): Promise<void> {
  let info;
  try {
    info = await lstat(directoryPath);
  } catch {
    throw new Error(`${description} does not exist: ${directoryPath}`);
  }
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symlink: ${directoryPath}`);
  if (!info.isDirectory()) throw new Error(`${description} is not a directory: ${directoryPath}`);
}

async function assertRegularFileWithoutSymlinks(filePath: string, packageDir: string, description: string): Promise<void> {
  const relativePath = path.relative(packageDir, filePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`${description} must stay inside the package directory`);
  }

  const segments = relativePath.split(path.sep);
  let currentPath = packageDir;
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    let info;
    try {
      info = await lstat(currentPath);
    } catch {
      throw new Error(`${description} does not exist: ${relativePath}`);
    }
    if (info.isSymbolicLink()) throw new Error(`${description} must not be a symlink: ${relativePath}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`${description} parent is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`${description} is not a regular file: ${relativePath}`);
    }
  }
}

function canonicalMarkdownPath(value: string): string {
  const normalizedSeparators = value.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("/") || /^[A-Za-z]:\//.test(normalizedSeparators)) {
    throw new Error(`Markdown path must be relative: ${value}`);
  }
  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Markdown path must not contain traversal segments: ${value}`);
  }
  const canonical = path.posix.normalize(normalizedSeparators);
  if (canonical === "." || canonical.startsWith("../") || canonical === ".." || canonical.startsWith("/")) {
    throw new Error(`Markdown path escapes the package directory: ${value}`);
  }
  if (!/\.(?:md|markdown)$/i.test(canonical)) {
    throw new Error(`Markdown path must end in .md or .markdown: ${value}`);
  }
  return canonical;
}

async function writeTextAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
    await chmod(temporaryPath, 0o644);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`scrape-agent export:html: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
