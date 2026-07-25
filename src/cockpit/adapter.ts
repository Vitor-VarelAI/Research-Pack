import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { RadarItemSchema, type RadarItem } from "../radar.js";
import { PublicationSchema, PUBLICATION_FORMAT_IDS, type Publication } from "../schemas/publication.js";
import { SourceGateResultSchema, type SourceGateResult } from "../schemas/source-gate.js";
import type {
  AdapterOptions,
  Artifact,
  CockpitModel,
  CockpitPackage,
  MarkdownArtifact,
  PackageFormat,
  PackageSummary,
  QaEvidence,
  RadarState,
} from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 400_000;
const DEFAULT_MAX_RUN_BYTES = 20_000_000;
const DEFAULT_MAX_RUN_LINE_BYTES = 600_000;
const DEFAULT_MAX_PACKAGES = 100;
const DEFAULT_MAX_FILES_PER_PACKAGE = 32;
const DEFAULT_MAX_AGGREGATE_BYTES = 8_000_000;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_PACKAGE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

const RunRecordSchema = z.object({
  command: z.string().min(1),
  output: z.unknown(),
  createdAt: z.string().datetime(),
});
const RadarOutputSchema = z.object({
  itemCount: z.number().int().nonnegative().optional(),
  items: z.array(RadarItemSchema),
});

type ReadBudget = {
  aggregateBytes: number;
  packageFiles: number;
};

type RadarRun = {
  createdAt: string;
  items: RadarItem[];
};

export class CockpitArtifactAdapter {
  private readonly configuredDataDir: string;
  private readonly dataRootKind: "configured" | "default";
  private readonly maxFileBytes: number;
  private readonly maxRunBytes: number;
  private readonly maxRunLineBytes: number;
  private readonly maxPackages: number;
  private readonly maxFilesPerPackage: number;
  private readonly maxAggregateBytes: number;

  public constructor(options: AdapterOptions = {}) {
    const configured = options.dataDir ?? process.env.SCRAPE_AGENT_DATA_DIR;
    this.dataRootKind = configured ? "configured" : "default";
    this.configuredDataDir = resolve(configured ?? resolve(process.cwd(), "data"));
    this.maxFileBytes = limit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxRunBytes = limit(options.maxRunBytes, DEFAULT_MAX_RUN_BYTES);
    this.maxRunLineBytes = limit(options.maxRunLineBytes, DEFAULT_MAX_RUN_LINE_BYTES);
    this.maxPackages = limit(options.maxPackages ?? options.maxPackageCount, DEFAULT_MAX_PACKAGES);
    this.maxFilesPerPackage = limit(options.maxFilesPerPackage ?? options.maxPackageFiles, DEFAULT_MAX_FILES_PER_PACKAGE);
    this.maxAggregateBytes = limit(options.maxAggregateBytes ?? options.maxTotalBytes, DEFAULT_MAX_AGGREGATE_BYTES);
  }

  public async load(selectedSlug?: string): Promise<CockpitModel> {
    const warnings: string[] = [];
    const budget: ReadBudget = { aggregateBytes: 0, packageFiles: 0 };
    const root = await this.safeRealpath(this.configuredDataDir);
    if (!root) {
      const radar = this.missingRadar("A pasta de dados não está disponível.");
      return {
        dataRoot: "missing",
        ...(selectedSlug ? { selectedSlug } : {}),
        packages: [],
        radar,
        warnings: ["A pasta de dados configurada não foi encontrada."],
        readOnly: true,
      };
    }

    const packages = await this.loadPackages(root, warnings, budget);
    const selected = selectedSlug && packages.some((item) => item.slug === selectedSlug)
      ? selectedSlug
      : packages[0]?.slug;
    const selectedPackage = selected ? packages.find((item) => item.slug === selected) : undefined;
    const radar = await this.loadLatestRadar(root, warnings);
    const freshness = getFreshness(radar, selectedPackage);

    return {
      dataRoot: this.dataRootKind,
      ...(selected ? { selectedSlug: selected } : {}),
      ...(selectedPackage ? { selectedPackage } : {}),
      packages: packages.map(toSummary),
      radar,
      warnings,
      ...(freshness ? { freshness } : {}),
      readOnly: true,
    };
  }

  private async loadPackages(root: string, warnings: string[], budget: ReadBudget): Promise<CockpitPackage[]> {
    const directory = await this.safeDirectory(root, "editorial");
    if (!directory) {
      warnings.push("O diretório editorial está ausente ou inacessível.");
      return [];
    }

    let entries: string[];
    try {
      const listing = await boundedDirectoryEntries(directory, this.maxPackages);
      entries = listing.entries
        .filter((entry) => entry.isDirectory() && SAFE_PACKAGE_SLUG.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a));
      if (listing.truncated) warnings.push(`O diretório editorial excede o limite de ${this.maxPackages} pacotes; os restantes foram ignorados.`);
    } catch {
      warnings.push("Não foi possível listar os pacotes editoriais.");
      return [];
    }

    const packages: CockpitPackage[] = [];
    for (const slug of entries) {
      const packageDirectory = await this.safeDirectory(root, `editorial/${slug}`);
      if (!packageDirectory) {
        warnings.push(`O pacote ${slug} foi ignorado porque o caminho não é seguro.`);
        continue;
      }
      budget.packageFiles = 0;
      packages.push(await this.loadPackage(root, slug, warnings, budget));
    }
    return packages.sort((a, b) => (b.publishedOn ?? "").localeCompare(a.publishedOn ?? "") || b.slug.localeCompare(a.slug));
  }

  private async loadPackage(root: string, slug: string, warnings: string[], budget: ReadBudget): Promise<CockpitPackage> {
    const packageWarnings: string[] = [];
    const manifest = await this.readJsonArtifact<Publication>(root, `editorial/${slug}/publication.json`, PublicationSchema, "publication.json", packageWarnings, budget, true);
    const diagnosis = await this.readMarkdown(root, `editorial/${slug}/diagnosis.md`, "diagnosis.md", packageWarnings, budget);
    const draft = await this.readMarkdown(root, `editorial/${slug}/draft.md`, "draft.md", packageWarnings, budget);
    const sourceGate = await this.readJsonArtifact<SourceGateResult>(root, `editorial/${slug}/source-gate.json`, SourceGateResultSchema, "source-gate.json", packageWarnings, budget, true);
    const humanNotes = await this.readMarkdown(root, `editorial/${slug}/qa-notes.md`, "qa-notes.md", packageWarnings, budget);
    const indexHtml = await this.readTextArtifact(root, `editorial/${slug}/index.html`, "index.html", packageWarnings, budget);

    const formats: PackageFormat[] = [];
    if (manifest.value) {
      for (const id of PUBLICATION_FORMAT_IDS) {
        const entry = manifest.value.formats[id];
        const markdown = await this.readMarkdown(root, `editorial/${slug}/${entry.path}`, entry.path, packageWarnings, budget);
        formats.push({ id, label: entry.label, path: entry.path, markdown });
      }
    }

    const qa = await this.loadQa(root, slug, sourceGate, humanNotes, packageWarnings, budget);
    warnings.push(...packageWarnings.map((warning) => `${slug}: ${warning}`));

    return {
      slug,
      ...(manifest.value?.publishedOn ? { publishedOn: manifest.value.publishedOn } : {}),
      manifest,
      diagnosis,
      draft,
      sourceGate,
      formats,
      qa,
      indexHtml,
      warnings: packageWarnings,
    };
  }

  private async loadQa(
    root: string,
    slug: string,
    canonical: Artifact<SourceGateResult>,
    humanNotes: MarkdownArtifact,
    warnings: string[],
    budget: ReadBudget,
  ): Promise<CockpitPackage["qa"]> {
    const directory = await this.safeDirectory(root, `editorial/${slug}`);
    const evidence: QaEvidence[] = [];
    if (directory) {
      try {
        const listing = await boundedDirectoryEntries(directory, this.maxFilesPerPackage);
        const allJsonFiles = listing.entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name)
          .sort();
        if (listing.truncated) warnings.push(`A pasta QA excede o limite de ${this.maxFilesPerPackage} ficheiros; os restantes foram ignorados.`);
        const files = allJsonFiles.filter((filename) => qaKind(filename) !== undefined);
        for (const filename of files) {
          const kind = qaKind(filename);
          if (!kind) continue;
          const artifact = await this.readJsonArtifact<unknown>(root, `editorial/${slug}/${filename}`, undefined, filename, warnings, budget, true);
          const parts = filename.split(".");
          const provider = parts.length > 2 ? parts[1] ?? "desconhecido" : "local";
          evidence.push({
            filename,
            provider: provider === "final" ? "local" : provider,
            final: parts.includes("final"),
            kind,
            artifact,
          });
        }
      } catch {
        warnings.push("Não foi possível listar as verificações QA.");
      }
    }

    return {
      canonical,
      humanNotes,
      html: evidence.filter((item) => item.kind === "html"),
      factCheck: evidence.filter((item) => item.kind === "fact-check"),
      lint: evidence.filter((item) => item.kind === "editorial-lint" || item.kind === "formats-lint"),
    };
  }

  private async loadLatestRadar(root: string, warnings: string[]): Promise<RadarState> {
    const runsPath = await this.safeFile(root, "runs/runs.jsonl");
    if (!runsPath) return this.missingRadar("O registo de corridas não está disponível.");

    let handle;
    try {
      handle = await open(runsPath, constants.O_RDONLY | NO_FOLLOW);
      const file = await handle.stat();
      if (!file.isFile()) return this.missingRadar("O registo de corridas não está disponível.");

      const scanBytes = Math.min(file.size, this.maxRunBytes);
      const start = file.size - scanBytes;
      const truncated = start > 0;
      const startsMidLine = await startsInMiddleOfLine(handle, start);
      if (truncated) {
        warnings.push(`O registo de corridas excede o orçamento de ${this.maxRunBytes} bytes; foi analisado apenas o trecho final${startsMidLine ? " e a primeira linha parcial foi ignorada" : ""}.`);
      }

      const data = await readRange(handle, scanBytes, start);
      const latest = this.parseRadarTail(data, startsMidLine, warnings);
      if (!latest) return { ...this.missingRadar("Ainda não existe uma corrida radar-hn válida."), ...(truncated ? { truncated: true } : {}) };
      return {
        status: "ok",
        value: {
          generatedAt: latest.createdAt,
          itemCount: latest.items.length,
          items: latest.items,
          global: true,
        },
        runAt: latest.createdAt,
        ...(truncated ? { truncated: true } : {}),
      };
    } catch {
      warnings.push("Não foi possível ler o registo de corridas.");
      return this.missingRadar("Não foi possível ler o registo de corridas.");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private parseRadarTail(data: Buffer, startsMidLine: boolean, warnings: string[]): RadarRun | undefined {
    let lineStart = 0;
    if (startsMidLine) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) return undefined;
      lineStart = newline + 1;
    }

    let oversizedLines = 0;
    let malformedLines = 0;
    let invalidRadarRuns = 0;
    let latest: RadarRun | undefined;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    while (lineStart < data.length) {
      const newline = data.indexOf(0x0a, lineStart);
      const lineEnd = newline >= 0 ? newline : data.length;
      const contentEnd = lineEnd > lineStart && data[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
      const lineBytes = contentEnd - lineStart;
      if (lineBytes > this.maxRunLineBytes) {
        oversizedLines += 1;
      } else if (lineBytes > 0) {
        const line = data.toString("utf8", lineStart, contentEnd);
        try {
          const parsed = RunRecordSchema.safeParse(JSON.parse(line) as unknown);
          if (!parsed.success) {
            malformedLines += 1;
          } else if (parsed.data.command === "radar-hn") {
            const output = RadarOutputSchema.safeParse(parsed.data.output);
            if (!output.success) {
              invalidRadarRuns += 1;
            } else {
              const timestamp = Date.parse(parsed.data.createdAt);
              if (timestamp >= latestTimestamp) {
                latestTimestamp = Number.isNaN(timestamp) ? latestTimestamp : timestamp;
                latest = { createdAt: parsed.data.createdAt, items: output.data.items };
              }
            }
          }
        } catch {
          malformedLines += 1;
        }
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    if (oversizedLines > 0) warnings.push(`${oversizedLines} linha(s) do registo de corridas excederam o limite e foram ignoradas.`);
    if (malformedLines > 0) warnings.push(`${malformedLines} linha(s) inválida(s) do registo de corridas foram ignoradas.`);
    if (invalidRadarRuns > 0) warnings.push(`Uma corrida radar-hn inválida: ${invalidRadarRuns} ocorrência(s) ignorada(s).`);
    return latest;
  }

  private missingRadar(detail: string): RadarState {
    return { status: "missing", detail };
  }

  private async readMarkdown(root: string, relativePath: string, label: string, warnings: string[], budget: ReadBudget): Promise<MarkdownArtifact> {
    return this.readTextArtifact(root, relativePath, label, warnings, budget);
  }

  private async readJsonArtifact<T>(
    root: string,
    relativePath: string,
    schema: z.ZodType<T> | undefined,
    label: string,
    warnings: string[],
    budget: ReadBudget,
    packageScoped: boolean,
  ): Promise<Artifact<T>> {
    const text = await this.readText(root, relativePath, budget, packageScoped);
    if (text.status !== "ok" || text.value === undefined) {
      warnings.push(formatArtifactWarning(label, text.status));
      if (text.detail && text.status === "too-large") warnings.push(`${label}: ${text.detail}`);
      return { status: text.status, ...(text.detail ? { detail: text.detail } : {}) };
    }
    const parsed = parseJsonPayload(text.value);
    if (!parsed.ok) {
      warnings.push(`${label} contém JSON inválido.`);
      return { status: "malformed", detail: "JSON inválido." };
    }
    if (!schema) return { status: "ok", value: parsed.value } as Artifact<T>;
    const checked = schema.safeParse(parsed.value);
    if (!checked.success) {
      warnings.push(`${label} não respeita o formato esperado.`);
      return { status: "malformed", detail: "Formato inesperado." };
    }
    return { status: "ok", value: checked.data };
  }

  private async readTextArtifact(root: string, relativePath: string, label: string, warnings: string[], budget: ReadBudget): Promise<MarkdownArtifact> {
    const result = await this.readText(root, relativePath, budget, true);
    if (result.status !== "ok") {
      warnings.push(formatArtifactWarning(label, result.status));
      if (result.detail && result.status === "too-large") warnings.push(`${label}: ${result.detail}`);
    }
    return result;
  }

  private async readText(root: string, relativePath: string, budget: ReadBudget, packageScoped: boolean): Promise<MarkdownArtifact> {
    const file = await this.safeFile(root, relativePath);
    if (!file) return { status: "missing", detail: "Ficheiro ausente ou caminho inseguro." };
    if (packageScoped && budget.packageFiles >= this.maxFilesPerPackage) {
      return { status: "too-large", detail: "O pacote excedeu o limite de ficheiros lidos." };
    }
    budget.packageFiles += packageScoped ? 1 : 0;

    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) return { status: "unreadable", detail: "Ficheiro inacessível." };
      if (fileStat.size > this.maxFileBytes) return { status: "too-large", detail: "Ficheiro acima do limite de leitura." };
      if (fileStat.size > this.maxAggregateBytes - budget.aggregateBytes) {
        return { status: "too-large", detail: "O orçamento agregado de leitura foi atingido." };
      }
      const buffer = await readRange(handle, fileStat.size, 0);
      budget.aggregateBytes += buffer.byteLength;
      return { status: "ok", value: buffer.toString("utf8") };
    } catch {
      return { status: "unreadable", detail: "Ficheiro inacessível." };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async safeDirectory(root: string, relativePath: string): Promise<string | undefined> {
    const candidate = safeJoin(root, relativePath);
    if (!candidate) return undefined;
    try {
      const entry = await lstat(candidate);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
      const resolved = await realpath(candidate);
      return isContained(root, resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  private async safeFile(root: string, relativePath: string): Promise<string | undefined> {
    const candidate = safeJoin(root, relativePath);
    if (!candidate) return undefined;
    try {
      const entry = await lstat(candidate);
      if (!entry.isFile()) return undefined;
      const resolved = await realpath(candidate);
      return isContained(root, resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  private async safeRealpath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }
}

/**
 * O_NOFOLLOW protects the final path component, and fstat/read operate on the
 * opened descriptor. Node has no portable openat-style API, so a concurrent
 * replacement of an intermediate directory remains a residual TOCTOU limit;
 * realpath containment is still checked before opening every artifact.
 */
async function boundedDirectoryEntries(directoryPath: string, limit: number): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const directory = await opendir(directoryPath);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    for await (const entry of directory) {
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, truncated };
}

async function startsInMiddleOfLine(handle: Awaited<ReturnType<typeof open>>, start: number): Promise<boolean> {
  if (start <= 0) return false;
  const marker = Buffer.alloc(1);
  const result = await handle.read(marker, 0, 1, start - 1);
  return result.bytesRead === 1 && marker[0] !== 0x0a;
}

async function readRange(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = length;
  let offset = position;
  while (remaining > 0) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const result = await handle.read(chunk, 0, chunk.length, offset);
    if (result.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, result.bytesRead));
    remaining -= result.bytesRead;
    offset += result.bytesRead;
  }
  return Buffer.concat(chunks);
}

export async function loadCockpitModel(options: AdapterOptions = {}, selectedSlug?: string): Promise<CockpitModel> {
  return new CockpitArtifactAdapter(options).load(selectedSlug);
}

function safeJoin(root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((segment) => segment === "..")) return undefined;
  const candidate = resolve(root, relativePath);
  return isContained(root, candidate) ? candidate : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function parseJsonPayload(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/giu;
    for (const match of text.matchAll(fenced)) {
      const candidate = match[1]?.trim();
      if (!candidate) continue;
      try {
        return { ok: true, value: JSON.parse(candidate) as unknown };
      } catch {
        // Try the next fenced payload, if a file contains more than one block.
      }
    }
  }
  return { ok: false };
}

function qaKind(filename: string): QaEvidence["kind"] | undefined {
  if (filename === "html-qa.json") return "html";
  if (/^fact-check(?:\..+)?\.json$/u.test(filename)) return "fact-check";
  if (/^editorial-lint(?:\..+)?\.json$/u.test(filename)) return "editorial-lint";
  if (/^formats-lint(?:\..+)?\.json$/u.test(filename)) return "formats-lint";
  return undefined;
}

function formatArtifactWarning(label: string, status: Artifact<unknown>["status"]): string {
  const text = status === "missing" ? "está ausente" : status === "too-large" ? "excede o limite" : "não pôde ser lido";
  return `${label} ${text}.`;
}

function toSummary(item: CockpitPackage): PackageSummary {
  return {
    slug: item.slug,
    title: item.manifest.value?.title ?? "Pacote sem manifesto válido",
    ...(item.publishedOn ? { publishedOn: item.publishedOn } : {}),
    status: item.manifest.status,
  };
}

function getFreshness(radar: RadarState, item: CockpitPackage | undefined): string | undefined {
  const dates = [radar.runAt, item?.publishedOn].filter((value): value is string => Boolean(value));
  if (dates.length === 0) return undefined;
  const latest = dates.sort().at(-1);
  if (!latest) return undefined;
  return new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(latest));
}

function limit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export { parseJsonPayload, safeJoin };
