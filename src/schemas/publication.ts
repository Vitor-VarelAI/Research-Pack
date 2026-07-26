import { z } from "zod";

const RelativeMarkdownPathSchema = z
  .string()
  .trim()
  .min(1, "Markdown path is required")
  .refine((value) => !value.includes("\0"), "Markdown path contains a null byte")
  .refine((value) => !isAbsolutePath(value), "Markdown path must be relative")
  .refine((value) => !hasTraversalSegment(value), "Markdown path must not contain traversal segments")
  .refine(
    (value) => /\.(?:md|markdown)$/i.test(value),
    "Markdown path must end in .md or .markdown",
  );

export const PublicationThemeSchema = z.enum(["ink", "paper", "sand", "blue", "red"]);

export const PublicationStatSchema = z.object({
  value: z.union([z.string().trim().min(1), z.number().finite()]),
  label: z.string().trim().min(1),
}).strict();

export const PublicationSlideSchema = z.object({
  id: z.string().trim().min(1),
  eyebrow: z.string().trim().min(1),
  title: z.string().trim().min(1),
  bodyMarkdown: z.string().trim().min(1),
  theme: PublicationThemeSchema,
  stat: PublicationStatSchema.optional(),
}).strict();

export const PublicationSlidesSchema = z.array(PublicationSlideSchema).length(10).superRefine((slides, context) => {
  const slideIds = slides.map((slide) => slide.id);
  if (new Set(slideIds).size !== slideIds.length) {
    context.addIssue({ code: "custom", message: "Slide ids must be unique" });
  }

  const themes = slides.map((slide) => slide.theme);
  if (themes[0] !== "ink") {
    context.addIssue({ code: "custom", path: [0, "theme"], message: "The first slide must use the ink theme" });
  }
  if (themes[themes.length - 1] !== "ink") {
    context.addIssue({ code: "custom", path: [themes.length - 1, "theme"], message: "The last slide must use the ink theme" });
  }
  const darkSlideCount = themes.filter((theme) => theme === "ink" || theme === "blue" || theme === "red").length;
  if (darkSlideCount < 5) {
    context.addIssue({ code: "custom", message: "At least five slides must use a dark theme" });
  }
  for (let index = 1; index < themes.length; index += 1) {
    if (themes[index] === themes[index - 1]) {
      context.addIssue({ code: "custom", path: [index, "theme"], message: "Adjacent slides must not use the same theme" });
    }
  }
});

const FormatEntrySchema = z.object({
  label: z.string().trim().min(1),
  path: RelativeMarkdownPathSchema,
}).strict();

export const PublicationFormatsSchema = z.object({
  blog: FormatEntrySchema,
  newsletter: FormatEntrySchema,
  linkedin: FormatEntrySchema,
  xThread: FormatEntrySchema,
  shortVideoIdeas: FormatEntrySchema,
  carousel: FormatEntrySchema,
  titlesHooks: FormatEntrySchema,
}).strict();

export const PublicationSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Slug must contain lowercase letters, numbers, and single hyphens only"),
  locale: z.literal("pt-PT"),
  publishedOn: z.string().date(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  slides: PublicationSlidesSchema,
  formats: PublicationFormatsSchema,
}).strict();

export type Publication = z.infer<typeof PublicationSchema>;
export type PublicationFormatId = keyof z.infer<typeof PublicationFormatsSchema>;

export const PUBLICATION_FORMAT_IDS: readonly PublicationFormatId[] = [
  "blog",
  "newsletter",
  "linkedin",
  "xThread",
  "shortVideoIdeas",
  "carousel",
  "titlesHooks",
];

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment === "..");
}
