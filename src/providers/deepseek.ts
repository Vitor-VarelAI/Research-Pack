import { z } from "zod";

export const DeepSeekConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().trim().min(1),
}).strict();
export type DeepSeekConfig = z.infer<typeof DeepSeekConfigSchema>;

export type DeepSeekMessage = {
  role: "system" | "user";
  content: string;
};

export type DeepSeekClientOptions = {
  fetchImpl?: typeof fetch;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
};

export type DeepSeekJsonRequest<T> = {
  messages: readonly DeepSeekMessage[];
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  temperature?: number;
};

export class DeepSeekRequestError extends Error {
  readonly code: "provider_timeout" | "provider_cancelled" | "provider_http" | "provider_invalid_response";
  readonly status: number | undefined;

  constructor(code: DeepSeekRequestError["code"], message: string, status?: number) {
    super(message);
    this.name = "DeepSeekRequestError";
    this.code = code;
    this.status = status;
  }
}

export type DeepSeekClient = {
  completeJson<T>(request: DeepSeekJsonRequest<T>): Promise<T>;
  generate<T>(request: DeepSeekJsonRequest<T>): Promise<T>;
  complete<T>(request: DeepSeekJsonRequest<T>): Promise<T>;
};

export const resolveDeepSeekServerConfig = resolveDeepSeekConfig;

export function resolveDeepSeekConfig(environment: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const apiKey = environment.DEEPSEEK_API_KEY;
  const baseUrl = environment.DEEPSEEK_BASE_URL;
  const model = environment.DEEPSEEK_MODEL;
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");
  if (!baseUrl) throw new Error("Missing DEEPSEEK_BASE_URL");
  if (!model) throw new Error("Missing DEEPSEEK_MODEL");
  return DeepSeekConfigSchema.parse({ apiKey, baseUrl, model });
}

export function createDeepSeekClient(config: DeepSeekConfig, options: DeepSeekClientOptions = {}): DeepSeekClient {
  const resolved = DeepSeekConfigSchema.parse(config);
  const fetchImpl = options.fetchImpl ?? options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  const maxRequestBytes = options.maxRequestBytes ?? 500_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("DeepSeek timeoutMs is outside the allowed range");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 10_000_000) throw new Error("DeepSeek maxResponseBytes is outside the allowed range");
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1_024 || maxRequestBytes > 2_000_000) throw new Error("DeepSeek maxRequestBytes is outside the allowed range");

  async function completeJson<T>(request: DeepSeekJsonRequest<T>): Promise<T> {
    if (request.messages.length === 0 || request.messages.length > 20) throw new Error("DeepSeek messages are outside the allowed range");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = (): void => controller.abort();
    if (request.signal?.aborted) throw new DeepSeekRequestError("provider_cancelled", "DeepSeek request cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const endpoint = new URL("chat/completions", `${resolved.baseUrl.replace(/\/+$/u, "")}/`).toString();
      const body = {
        model: resolved.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        response_format: { type: "json_object" },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      };
      const serializedBody = JSON.stringify(body);
      if (Buffer.byteLength(serializedBody, "utf8") > maxRequestBytes) throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek request exceeded the size limit");
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resolved.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: serializedBody,
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new DeepSeekRequestError("provider_timeout", "DeepSeek request timed out");
        if (request.signal?.aborted || controller.signal.aborted) throw new DeepSeekRequestError("provider_cancelled", "DeepSeek request cancelled");
        throw new DeepSeekRequestError("provider_http", "DeepSeek request failed");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxResponseBytes) throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek response exceeded the size limit", response.status);
      let text: string;
      try {
        text = await readBoundedText(response, maxResponseBytes);
      } catch (error) {
        if (timedOut) throw new DeepSeekRequestError("provider_timeout", "DeepSeek request timed out");
        if (request.signal?.aborted || controller.signal.aborted) throw new DeepSeekRequestError("provider_cancelled", "DeepSeek request cancelled");
        throw error;
      }
      if (!response.ok) throw new DeepSeekRequestError("provider_http", `DeepSeek request failed with HTTP ${response.status}`, response.status);
      let raw: unknown;
      try { raw = JSON.parse(text) as unknown; } catch { throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek returned invalid JSON", response.status); }
      const envelope = DeepSeekResponseSchema.safeParse(raw);
      if (!envelope.success) throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek returned an invalid response", response.status);
      let value: unknown;
      try { value = JSON.parse(stripJsonFence(envelope.data.choices[0]!.message.content)) as unknown; } catch { throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek returned invalid structured JSON", response.status); }
      const parsed = request.schema.safeParse(value);
      if (!parsed.success) throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek structured output failed validation", response.status);
      return parsed.data;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  return { completeJson, generate: completeJson, complete: completeJson };
}

export const createDeepSeekHttpClient = createDeepSeekClient;

const DeepSeekResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }).strict() }).strict()).min(1),
}).strict();

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DeepSeekRequestError("provider_invalid_response", "DeepSeek response exceeded the size limit", response.status);
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1] ?? trimmed;
}
