import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, type McpHttpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, MCP_PROTOCOL_VERSION } from "./config.js";
import { createServerFactory } from "./server.js";

const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
const MAX_HTTP_REQUEST_TIME_MS = 15_000;

class RequestBodyTooLargeError extends Error {}
class RequestBodyTimeoutError extends Error {}

function readBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.pause();
      reject(new RequestBodyTimeoutError(`MCP request exceeded ${MAX_HTTP_REQUEST_TIME_MS} ms`));
    }, MAX_HTTP_REQUEST_TIME_MS);
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > MAX_HTTP_REQUEST_BYTES) {
        settled = true;
        clearTimeout(timeout);
        request.pause();
        reject(new RequestBodyTooLargeError(`MCP request exceeds ${MAX_HTTP_REQUEST_BYTES} bytes`));
        return;
      }
      chunks.push(value);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function asWebRequest(request: import("node:http").IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = `http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`;
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = body.toString("utf8");
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(response: Response, nodeResponse: import("node:http").ServerResponse) {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
  const body = Buffer.from(await response.arrayBuffer());
  nodeResponse.end(body);
}

function isAllowedSharedSecret(request: import("node:http").IncomingMessage, expected?: string): boolean {
  if (!expected) return true;
  const provided = request.headers["x-mcp-shared-secret"];
  if (typeof provided !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function createHttpHandler(): McpHttpHandler {
  return createMcpHandler(createServerFactory(), {
    // HTTP is deliberately strict: clients must speak the 2026-07-28 envelope.
    legacy: "reject",
    responseMode: "json",
    onerror: (error) => console.error(`[mcp] ${error.message}`),
  });
}

export async function startHttpServer() {
  const config = loadConfig();
  const handler = createHttpHandler();
  const httpServer = createServer(async (request, response) => {
    try {
      if (request.url === "/healthz") {
        if (!isAllowedSharedSecret(request, config.sharedSecret)) {
          response.statusCode = 401;
          response.end("Unauthorized");
          return;
        }
        const healthRequest = asWebRequest(request, Buffer.alloc(0));
        const healthHostRejection = hostHeaderValidationResponse(healthRequest, config.allowedHosts);
        const healthOriginRejection = originValidationResponse(healthRequest, config.allowedHosts);
        if (healthHostRejection ?? healthOriginRejection) {
          await writeResponse(healthHostRejection ?? healthOriginRejection!, response);
          return;
        }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ ok: true, protocolVersion: MCP_PROTOCOL_VERSION, stateless: true }));
        return;
      }
      if (request.url?.split("?", 1)[0] !== "/mcp") {
        response.statusCode = 404;
        response.end("Not Found");
        return;
      }
      if (!isAllowedSharedSecret(request, config.sharedSecret)) {
        response.statusCode = 401;
        response.end("Unauthorized");
        return;
      }
      const contentLength = Number.parseInt(request.headers["content-length"] ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_REQUEST_BYTES) {
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        response.statusCode = 413;
        response.end("Payload Too Large", () => request.destroy());
        return;
      }
      const body = await readBody(request);
      const webRequest = asWebRequest(request, body);
      const hostRejection = hostHeaderValidationResponse(webRequest, config.allowedHosts);
      const originRejection = originValidationResponse(webRequest, config.allowedHosts);
      if (hostRejection ?? originRejection) {
        await writeResponse(hostRejection ?? originRejection!, response);
        return;
      }
      await writeResponse(await handler.fetch(webRequest), response);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        response.statusCode = 413;
        response.end("Payload Too Large", () => request.destroy());
        return;
      }
      if (error instanceof RequestBodyTimeoutError) {
        response.shouldKeepAlive = false;
        response.setHeader("Connection", "close");
        response.statusCode = 408;
        response.end("Request Timeout", () => request.destroy());
        return;
      }
      console.error(`[mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      response.statusCode = 500;
      response.end("Internal Server Error");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.error(`[mcp] listening on http://${config.host}:${config.port}/mcp (${MCP_PROTOCOL_VERSION}, stateless)`);
  return httpServer;
}

async function main() {
  const config = loadConfig();
  if (config.transport === "http") {
    await startHttpServer();
    return;
  }
  serveStdio(createServerFactory(), { legacy: "serve", onerror: (error) => console.error(`[mcp] ${error.message}`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
