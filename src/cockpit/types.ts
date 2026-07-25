import type { Publication } from "../schemas/publication.js";
import type { RadarItem } from "../radar.js";
import type { SourceGateResult } from "../schemas/source-gate.js";

export type ArtifactStatus = "ok" | "missing" | "malformed" | "unreadable" | "too-large";

export type Artifact<T> = {
  status: ArtifactStatus;
  value?: T;
  detail?: string;
};

export type MarkdownArtifact = Artifact<string> & {
  html?: string;
};

export type RadarState = Artifact<{
  generatedAt: string;
  itemCount: number;
  items: RadarItem[];
  global: true;
}> & {
  runAt?: string;
  truncated?: boolean;
};

export type PackageFormat = {
  id: keyof Publication["formats"];
  label: string;
  path: string;
  markdown: MarkdownArtifact;
};

export type QaEvidence = {
  filename: string;
  provider: string;
  final: boolean;
  kind: "fact-check" | "editorial-lint" | "formats-lint" | "html" | "unknown";
  artifact: Artifact<unknown>;
};

export type PackageQa = {
  canonical: Artifact<SourceGateResult>;
  humanNotes: MarkdownArtifact;
  html: QaEvidence[];
  factCheck: QaEvidence[];
  lint: QaEvidence[];
};

export type CockpitPackage = {
  slug: string;
  publishedOn?: string;
  manifest: Artifact<Publication>;
  diagnosis: MarkdownArtifact;
  draft: MarkdownArtifact;
  sourceGate: Artifact<SourceGateResult>;
  formats: PackageFormat[];
  qa: PackageQa;
  indexHtml: Artifact<string>;
  warnings: string[];
};

export type PackageSummary = {
  slug: string;
  title: string;
  publishedOn?: string;
  status: ArtifactStatus;
};

export type CockpitModel = {
  dataRoot: "configured" | "default" | "missing";
  selectedSlug?: string;
  selectedPackage?: CockpitPackage;
  packages: PackageSummary[];
  radar: RadarState;
  warnings: string[];
  freshness?: string;
  readOnly: true;
};

export type AdapterOptions = {
  dataDir?: string;
  maxFileBytes?: number;
  maxRunBytes?: number;
  maxRunLineBytes?: number;
  maxPackages?: number;
  /** Alias kept for callers that name this budget after the directory count. */
  maxPackageCount?: number;
  maxFilesPerPackage?: number;
  /** Alias kept for callers that name this budget after package contents. */
  maxPackageFiles?: number;
  maxAggregateBytes?: number;
  /** Alias kept for callers that name this budget as a total byte limit. */
  maxTotalBytes?: number;
};
