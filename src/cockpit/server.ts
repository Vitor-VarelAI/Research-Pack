import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadCockpitModel } from "./adapter.js";
import { createControlPlane, type ControlPlane, type ControlPlaneOptions } from "./control-plane.js";
import { renderCockpitHtml } from "./renderer.js";
import type { AdapterOptions } from "./types.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;
export const UNSAFE_HOST_OPT_IN = "SCRAPE_AGENT_ALLOW_UNSAFE_HOST";

export type CockpitServerOptions = AdapterOptions & ControlPlaneOptions & {
  host?: string;
  port?: number;
  controlPlane?: ControlPlane;
};

export function createCockpitServer(options: CockpitServerOptions = {}): Server {
  let controlPlane: ControlPlane | undefined;
  try {
    controlPlane = options.controlPlane ?? createControlPlane(options);
  } catch {
    // Defer unsafe option access to the request boundary, where it becomes a safe 500.
  }
  return createServer(async (request, response) => {
    try {
      await handleCockpitRequest(request, response, options, controlPlane);
    } catch {
      writeSafeError(response, request.method === "HEAD");
    }
  });
}

export async function handleCockpitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CockpitServerOptions = {},
  suppliedControlPlane?: ControlPlane,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    writeText(response, 400, "Pedido inválido\n", request.method === "HEAD");
    return;
  }

  const controlPlane = suppliedControlPlane ?? createControlPlane(options);
  if (url.pathname.startsWith("/api/jobs")) {
    await controlPlane.handle(request, response, url.pathname);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      "Allow": "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : "Método não permitido\n");
    return;
  }

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    writeText(response, 404, "Não encontrado\n", request.method === "HEAD");
    return;
  }

  const selectedSlug = url.searchParams.get("package") ?? undefined;
  try {
    const jobs = await controlPlane.getJobs();
    const completedSlug = jobs.find((job) => job.state === "completed" && job.packageSlug)?.packageSlug ?? undefined;
    const model = await loadCockpitModel(options, selectedSlug ?? completedSlug);
    const scriptNonce = randomBytes(18).toString("base64");
    const html = renderCockpitHtml(model, {
      actionsEnabled: controlPlane.actionsEnabled,
      runnerReady: controlPlane.runnerReady,
      csrfToken: controlPlane.csrfToken,
      jobs,
      scriptNonce,
    });
    writeHtml(response, 200, html, request.method === "HEAD", scriptNonce);
  } catch {
    writeSafeError(response, request.method === "HEAD");
  }
}

function writeHtml(response: ServerResponse, status: number, html: string, head: boolean, scriptNonce?: string): void {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html, "utf8").toString(),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'${scriptNonce ? ` 'nonce-${scriptNonce}'` : ""}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'none'`,
  };
  response.writeHead(status, headers);
  response.end(head ? undefined : html);
}

function writeSafeError(response: ServerResponse, head: boolean): void {
  try {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    const html = `<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cockpit indisponível</title>
</head>
<body>
  <main>
    <h1>Cockpit indisponível</h1>
    <p>O read model local não pôde ser carregado neste momento.</p>
  </main>
</body>
</html>`;
    writeHtml(response, 500, html, head);
  } catch {
    if (!response.destroyed) response.destroy();
  }
}

export async function startCockpitServer(options: CockpitServerOptions = {}): Promise<Server> {
  const requestedHost = options.host ?? process.env.SCRAPE_AGENT_HOST ?? DEFAULT_HOST;
  const host = resolveCockpitHost(requestedHost);
  const rawPort = options.port ?? Number(process.env.SCRAPE_AGENT_PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65_535 ? rawPort : DEFAULT_PORT;
  const server = createCockpitServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (!isLoopbackHost(host)) {
    console.warn(`Aviso de segurança: o cockpit está exposto em ${host}; mantenha ${UNSAFE_HOST_OPT_IN}=1 apenas com uma rede confiável.`);
  }
  const displayHost = host.includes(":") ? `[${host}]` : host;
  console.log(`Cockpit editorial em http://${displayHost}:${actualPort}`);
  return server;
}

export function resolveCockpitHost(host: string): string {
  const normalized = normalizeCockpitHost(host);
  if (!normalized) throw new Error("O host do cockpit não pode estar vazio.");
  if (isLoopbackHost(normalized)) return normalized;
  const optIn = process.env[UNSAFE_HOST_OPT_IN]?.trim().toLowerCase();
  if (optIn !== "1") {
    throw new Error(`O host ${normalized || host} não é loopback. Defina ${UNSAFE_HOST_OPT_IN}=1 para autorizar explicitamente uma ligação insegura.`);
  }
  return normalized;
}

export function normalizeCockpitHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeCockpitHost(host).toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.slice(1).every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
}

function writeText(response: ServerResponse, status: number, text: string, head: boolean): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text, "utf8").toString(),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(head ? undefined : text);
}

const isEntrypoint = process.argv[1]?.endsWith("/cockpit/server.ts") || process.argv[1]?.endsWith("/cockpit/server.js");
if (isEntrypoint) {
  void startCockpitServer().catch(() => {
    console.error("Não foi possível iniciar o cockpit.");
    process.exitCode = 1;
  });
}
