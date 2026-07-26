import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePackage = path.join(repoRoot, "tests", "fixtures", "editorial-package");

// These tests deliberately invoke the package script rather than importing the
// renderer, so the documented delivery path is covered end to end.
describe("export:html", () => {
  it("exports a self-contained ten-slide package with copy payloads", () => {
    const { root, packageDir } = copyFixture();
    try {
      const result = runExport(path.relative(repoRoot, packageDir));
      assert.equal(result.status, 0, result.stderr);
      const outputPath = path.join(packageDir, "index.html");
      const html = readFileSync(outputPath, "utf8");

      assert.equal(statSync(outputPath).mode & 0o777, 0o644);
      assert.equal(count(html, /<article id="slide-/g), 10);
      assert.equal(count(html, /class="slide theme-/g), 10);
      assert.deepEqual([...html.matchAll(/class="slide theme-([a-z]+)"/g)].map((match) => match[1]), [
        "ink", "paper", "blue", "sand", "red", "paper", "blue", "sand", "red", "ink",
      ]);
      assert.equal(count(html, /class="slide theme-(?:ink|blue|red)"/g), 6);
      assert.equal(count(html, /class="slide theme-[a-z]+"[^>]*>[\s\S]*?class="slide-number"/g), 10);
      assert.match(html, /scroll-snap-type:\s*x mandatory/);
      assert.match(html, /width:\s*100vw/);
      assert.match(html, /height:\s*100dvh/);
      assert.match(html, /overflow-y:\s*hidden/);
      assert.match(html, /font-size:\s*clamp\(6\.5rem,\s*15vw,\s*11rem\)/);
      assert.match(html, />128%</);
      assert.match(html, />240</);

      for (const format of ["blog", "newsletter", "linkedin", "xThread", "shortVideoIdeas", "carousel", "titlesHooks"]) {
        assert.match(html, new RegExp(`data-format-id="${format}"`));
      }
      for (const label of ["Blog", "Newsletter", "LinkedIn", "X/thread", "Vídeos", "Carrossel", "Títulos &amp; hooks"]) {
        assert.match(html, new RegExp(label));
      }
      assert.equal(count(html, /data-copy-kind="plain"/g), 7);
      assert.equal(count(html, /data-copy-kind="rich"/g), 2);
      assert.match(html, /plainText/);
      assert.match(html, /richHtml/);
      assert.match(html, /A notícia era o sintoma/);
      assert.match(html, /Lido de perto, é distribuição/);
      assert.match(html, /Fonte original \(https:\/\/example\.com\/source\?a=1(?:&amp;|\\u0026)b=2\)/);

      assert.doesNotMatch(html, /<link\b/i);
      assert.doesNotMatch(html, /<(?:script|img|iframe)\b[^>]+(?:src|href)=/i);
      assert.doesNotMatch(html, /@import\s+url\(|url\(/i);
      assert.doesNotMatch(html, /https?:\/\/[^"']+\.(?:css|js|woff2?|ttf)(?:["'?#]|$)/i);
      assert.doesNotMatch(html, /# A notícia era o sintoma/);
      assert.doesNotMatch(html, /\*\*Lido de perto/);

      assert.match(html, /IntersectionObserver/);
      assert.match(html, /event\.key === 'ArrowLeft'/);
      assert.match(html, /event\.key === 'ArrowRight'/);
      assert.match(html, /event\.key === 'Home'/);
      assert.match(html, /event\.key === 'End'/);
      assert.match(html, /navigator\.clipboard/);
      assert.match(html, /Rich text indisponível; texto simples copiado\./);
      assert.match(html, /document\.execCommand\('copy'\)/);
      assert.match(html, /prefers-reduced-motion/);
      assert.match(html, /aria-live="polite"/);
      assert.match(html, /aria-label="Navegação dos slides"/);
      assert.match(html, /formatTabs\[nextIndex\]/);
      assert.match(html, /tab\.tabIndex = selected \? 0 : -1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes raw Markdown HTML before embedding it", () => {
    const { root, packageDir } = copyFixture();
    try {
      writeFileSync(path.join(packageDir, "formats", "blog.md"), "# Seguro\n\n<script>alert('xss')</script><img src=x onerror=alert(1)>\n\n**texto**");
      const result = runExport(packageDir);
      assert.equal(result.status, 0, result.stderr);
      const html = readFileSync(path.join(packageDir, "index.html"), "utf8");
      assert.doesNotMatch(html, /<script>alert/);
      assert.doesNotMatch(html, /onerror=/i);
      assert.doesNotMatch(html, /# Seguro/);
      assert.doesNotMatch(html, /\*\*texto\*\*/);
      assert.match(html, /Seguro/);
      assert.match(html, /texto/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid manifests and unsafe Markdown paths", () => {
    const cases: Array<{ name: string; mutate: (packageDir: string, root: string) => void; message: RegExp }> = [
      {
        name: "absolute path",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.formats.blog.path = "/etc/passwd.md"; }),
        message: /must be relative/i,
      },
      {
        name: "traversal path",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.formats.blog.path = "../outside.md"; }),
        message: /traversal|escapes/i,
      },
      {
        name: "missing file",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.formats.blog.path = "formats/missing.md"; }),
        message: /does not exist/i,
      },
      {
        name: "duplicate path",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.formats.blog.path = manifest.formats.newsletter.path; }),
        message: /duplicate/i,
      },
      {
        name: "slug mismatch",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.slug = "different-slug"; }),
        message: /slug.*basename/i,
      },
      {
        name: "invalid slug",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.slug = "Editorial Package"; }),
        message: /slug.*lowercase/i,
      },
      {
        name: "duplicate slide ids",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.slides[1].id = manifest.slides[0].id; }),
        message: /slide ids.*unique/i,
      },
      {
        name: "adjacent themes",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.slides[1].theme = manifest.slides[0].theme; }),
        message: /adjacent/i,
      },
      {
        name: "first and last themes",
        mutate: (packageDir) => updateManifest(packageDir, (manifest) => { manifest.slides[0].theme = "paper"; }),
        message: /first slide/i,
      },
    ];

    for (const testCase of cases) {
      const { root, packageDir } = copyFixture();
      try {
        testCase.mutate(packageDir, root);
        const result = runExport(packageDir);
        assert.notEqual(result.status, 0, testCase.name);
        assert.match(result.stderr, testCase.message, testCase.name);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects missing and symlinked Markdown files", () => {
    const missing = copyFixture();
    try {
      unlinkSync(path.join(missing.packageDir, "formats", "blog.md"));
      const result = runExport(missing.packageDir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not exist/i);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }

    const linked = copyFixture();
    try {
      const external = path.join(linked.root, "external.md");
      writeFileSync(external, "external");
      unlinkSync(path.join(linked.packageDir, "formats", "blog.md"));
      symlinkSync(external, path.join(linked.packageDir, "formats", "blog.md"));
      const result = runExport(linked.packageDir);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not be a symlink/i);
    } finally {
      rmSync(linked.root, { recursive: true, force: true });
    }
  });

  it("leaves the previous index intact when validation fails", () => {
    const { root, packageDir } = copyFixture();
    try {
      const first = runExport(packageDir);
      assert.equal(first.status, 0, first.stderr);
      const outputPath = path.join(packageDir, "index.html");
      const previous = readFileSync(outputPath, "utf8");
      writeFileSync(outputPath, "previous complete export");
      updateManifest(packageDir, (manifest) => { manifest.slides[1].theme = manifest.slides[0].theme; });

      const failed = runExport(packageDir);
      assert.notEqual(failed.status, 0);
      assert.equal(readFileSync(outputPath, "utf8"), "previous complete export");
      assert.ok(existsSync(outputPath));
      assert.equal(readdirSync(packageDir).some((entry) => entry.startsWith("index.html.tmp-")), false);
      assert.notEqual(previous, "previous complete export");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

type Manifest = {
  slug: string;
  slides: Array<{ id: string; theme: string; stat?: { value: string; label: string } }>;
  formats: Record<string, { label: string; path: string }>;
};

function copyFixture(): { root: string; packageDir: string } {
  const root = mkdtempSync(path.join("/tmp", "scrape-agent-export-"));
  const packageDir = path.join(root, "editorial-package");
  cpSync(fixturePackage, packageDir, { recursive: true });
  return { root, packageDir };
}

function updateManifest(packageDir: string, mutate: (manifest: Manifest) => void): void {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "publication.json"), "utf8")) as Manifest;
  mutate(manifest);
  writeFileSync(path.join(packageDir, "publication.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function runExport(packageDir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npm", ["run", "export:html", "--", packageDir], {
    cwd: repoRoot,
    env: { ...process.env, SCRAPE_AGENT_DATA_DIR: mkdtempSync(path.join("/tmp", "scrape-agent-data-")) },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}
