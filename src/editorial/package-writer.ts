import { mkdir, lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exportEditorialHtml } from "../export-html.js";
import { EditorialJobSchema, type EditorialJob } from "../schemas/editorial-job.js";
import {
  EditorialAngleCandidatesSchema,
  EditorialDiagnosisSchema,
  EditorialDraftSchema,
  EditorialFormatsSchema,
  EditorialResearchPackSchema,
  EditorialQaSchema,
  type EditorialAngleCandidates,
  type EditorialDiagnosis,
  type EditorialDraft,
  type EditorialFormats,
  type EditorialQa,
  type EditorialResearchPack,
} from "../schemas/editorial-generation.js";
import { PublicationSchema, type Publication } from "../schemas/publication.js";
import { nowIso } from "../util.js";

export type EditorialPackageWriteInput = {
  job: EditorialJob;
  researchPack: EditorialResearchPack;
  angles: EditorialAngleCandidates;
  diagnosis: EditorialDiagnosis;
  draft: EditorialDraft;
  formats: EditorialFormats;
  qa: EditorialQa;
};

export type EditorialPackageWriteResult = {
  slug: string;
  relativePath: string;
  packageDir: string;
  publication: Publication;
  htmlPath: string | null;
};

export type PackageWriter = {
  write(input: EditorialPackageWriteInput): Promise<EditorialPackageWriteResult>;
};

const FORMAT_PATHS = {
  blog: "publication/blog.md",
  newsletter: "publication/newsletter.md",
  linkedin: "publication/linkedin.md",
  xThread: "publication/x-thread.md",
  shortVideoIdeas: "publication/short-video-ideas.md",
  carousel: "publication/carousel.md",
  titlesHooks: "publication/titles-hooks.md",
} as const;

const PUBLICATION_THEME_SEQUENCE = ["ink", "paper", "blue", "sand", "red", "paper", "blue", "sand", "red", "ink"] as const;

export function createPackageWriter(dataRoot: string, options: { exportHtml?: boolean } = {}): PackageWriter {
  const root = path.resolve(dataRoot);
  const editorialRoot = path.join(root, "editorial");
  return { write: (input) => writeEditorialPackage(input, root, editorialRoot, options.exportHtml ?? input.job.input.exportHtml) };
}

export async function writeEditorialPackage(input: EditorialPackageWriteInput, dataRoot: string, editorialRoot = path.join(path.resolve(dataRoot), "editorial"), exportHtml = input.job.input.exportHtml): Promise<EditorialPackageWriteResult> {
  const job = EditorialJobSchema.parse(input.job);
  const researchPack = EditorialResearchPackSchema.parse(input.researchPack);
  const angles = EditorialAngleCandidatesSchema.parse(input.angles);
  const diagnosis = EditorialDiagnosisSchema.parse(input.diagnosis);
  const draft = EditorialDraftSchema.parse(input.draft);
  const formats = EditorialFormatsSchema.parse(input.formats);
  const qa = EditorialQaSchema.parse(input.qa);
  if (!qa.editorialLint || !qa.formatsLint) throw new Error("Cannot promote an editorial package without structured QA");

  await mkdir(path.resolve(dataRoot), { recursive: true, mode: 0o700 });
  await assertDirectory(path.resolve(dataRoot), "data root");
  await mkdir(editorialRoot, { recursive: true, mode: 0o700 });
  await assertDirectory(editorialRoot, "editorial root");
  const baseSlug = slugify(draft.title);
  let slug = baseSlug;
  let finalDir = path.join(editorialRoot, slug);
  if (await exists(finalDir)) {
    slug = `${baseSlug}-${job.id.slice(-8)}`;
    finalDir = path.join(editorialRoot, slug);
  }
  assertContained(editorialRoot, finalDir);
  const stagingParent = path.join(editorialRoot, `.staging-${job.id}-${randomUUID()}`);
  const stagingRoot = path.join(stagingParent, slug);
  assertContained(editorialRoot, stagingParent);
  assertContained(stagingParent, stagingRoot);
  await mkdir(stagingParent, { recursive: false, mode: 0o700 });
  await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  try {
    await writeJson(path.join(stagingRoot, "research-pack.json"), researchPack);
    await writeJson(path.join(stagingRoot, "source-gate.json"), researchPack.sourceGate);
    await writeJson(path.join(stagingRoot, "editorial-lint.deepseek.final.json"), qa.editorialLint);
    await writeJson(path.join(stagingRoot, "formats-lint.deepseek.final.json"), qa.formatsLint);
    await writeJson(path.join(stagingRoot, "angles.json"), angles);
    await writeText(path.join(stagingRoot, "diagnosis.md"), diagnosisMarkdown(diagnosis, job.selectedAngle?.title ?? ""));
    await writeText(path.join(stagingRoot, "draft.md"), draft.bodyMarkdown);
    await writeText(path.join(stagingRoot, "qa-notes.md"), qaMarkdown(qa));
    await mkdir(path.join(stagingRoot, "publication"), { mode: 0o700 });

    const publication = PublicationSchema.parse({
      schemaVersion: 1,
      slug,
      locale: "pt-PT",
      publishedOn: job.createdAt.slice(0, 10),
      title: draft.title,
      description: draft.description,
      slides: formats.slides.map((slide, index) => ({
        ...slide,
        id: `slide-${index + 1}`,
        theme: PUBLICATION_THEME_SEQUENCE[index]!,
      })),
      formats: {
        blog: { label: "Blog", path: FORMAT_PATHS.blog },
        newsletter: { label: "Newsletter", path: FORMAT_PATHS.newsletter },
        linkedin: { label: "LinkedIn", path: FORMAT_PATHS.linkedin },
        xThread: { label: "X/thread", path: FORMAT_PATHS.xThread },
        shortVideoIdeas: { label: "Vídeos", path: FORMAT_PATHS.shortVideoIdeas },
        carousel: { label: "Carrossel", path: FORMAT_PATHS.carousel },
        titlesHooks: { label: "Títulos & hooks", path: FORMAT_PATHS.titlesHooks },
      },
    });
    await writeJson(path.join(stagingRoot, "publication.json"), publication);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.blog), draft.bodyMarkdown);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.newsletter), formats.newsletter);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.linkedin), formats.linkedin);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.xThread), formats.xThread);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.shortVideoIdeas), formats.shortVideoIdeas);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.carousel), formats.carousel);
    await writeText(path.join(stagingRoot, FORMAT_PATHS.titlesHooks), formats.titlesHooks);

    let htmlPath: string | null = null;
    if (exportHtml) {
      const result = await exportEditorialHtml(stagingRoot);
      htmlPath = path.relative(path.resolve(dataRoot), result.outputPath).split(path.sep).join("/");
    }
    await assertNoSymlinkTree(stagingRoot);
    await rename(stagingRoot, finalDir);
    await rm(stagingParent, { recursive: true, force: true });
    return {
      slug,
      relativePath: path.relative(path.resolve(dataRoot), finalDir).split(path.sep).join("/"),
      packageDir: finalDir,
      publication,
      htmlPath: htmlPath ? path.join("editorial", slug, "index.html") : null,
    };
  } catch (error) {
    await rm(stagingParent, { recursive: true, force: true });
    throw error;
  }
}

function slugify(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return slug || `editorial-${nowIso().slice(0, 10)}`;
}

function diagnosisMarkdown(diagnosis: EditorialDiagnosis, angle: string): string {
  return [
    `# Diagnóstico${angle ? `: ${angle}` : ""}`,
    "",
    diagnosis.centralInsight,
    "",
    "## Mecanismo",
    diagnosis.mechanism,
    "",
    "## Stakes",
    diagnosis.stakes,
    "",
    "## Implicações",
    diagnosis.implications,
    "",
    "## Recomendação",
    diagnosis.recommendation,
    "",
    "## Ledger",
    ...diagnosis.ledger.map((entry) => `- **${entry.classification}** ${entry.statement} — ${entry.rationale}`),
    "",
  ].join("\n");
}

function qaMarkdown(qa: EditorialQa): string {
  return [
    `# QA`,
    "",
    `Resultado das verificações: ${qa.passed ? "passou" : "com alertas para revisão"}`,
    `Claims verificados: ${qa.checkedClaims}`,
    "",
    "Aprovação humana final: aprovada.",
    "",
    ...qa.warnings.map((warning) => `- ${warning}`),
    "",
  ].join("\n");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertDirectory(directory: string, description: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`${description} must not be a symlink`);
  if (!info.isDirectory()) throw new Error(`${description} is not a directory`);
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Editorial package path escapes data root");
}

async function assertNoSymlinkTree(root: string): Promise<void> {
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(root, entry.name);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Editorial package contains a symlink: ${entry.name}`);
    if (info.isDirectory()) await assertNoSymlinkTree(current);
  }
}
