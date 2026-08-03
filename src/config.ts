import "dotenv/config";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

export type AuthMode = "user_oauth" | "service_account";

export interface AppConfig {
  apiBaseUrl: string;
  accessToken?: string;
  authMode: AuthMode;
  defaultUserId?: string;
  mock: boolean;
  enforceScopes: boolean;
  scopes: ReadonlySet<string>;
  transport: "stdio" | "http";
  host: string;
  port: number;
  sharedSecret?: string;
  allowedHosts: string[];
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false)`);
}

export function loadConfig(): AppConfig {
  const apiBaseUrl = env("NAVER_WORKS_API_BASE") ?? "https://www.worksapis.com/v1.0";
  const mock = boolEnv("NAVER_WORKS_MOCK", false);
  const parsedBase = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("NAVER_WORKS_API_BASE must be an http(s) URL without credentials, query, or fragment");
  }
  if (!mock && parsedBase.protocol !== "https:") {
    throw new Error("NAVER_WORKS_API_BASE must use HTTPS outside mock mode");
  }
  parsedBase.pathname = parsedBase.pathname.replace(/\/+$/, "");

  const authMode = (env("NAVER_WORKS_AUTH_MODE") ?? "user_oauth") as AuthMode;
  if (authMode !== "user_oauth" && authMode !== "service_account") {
    throw new Error("NAVER_WORKS_AUTH_MODE must be user_oauth or service_account");
  }

  const transport = (env("MCP_TRANSPORT") ?? "stdio") as "stdio" | "http";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("MCP_TRANSPORT must be stdio or http");
  }

  const host = env("MCP_HOST") ?? "127.0.0.1";
  const sharedSecret = env("MCP_SHARED_SECRET");
  const allowedHosts = (env("MCP_ALLOWED_HOSTS") ?? "localhost,127.0.0.1,[::1]")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const loopbackHost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (transport === "http" && !loopbackHost && (!sharedSecret || sharedSecret.length < 32)) {
    throw new Error("Remote HTTP binding requires an MCP_SHARED_SECRET of at least 32 characters and a TLS-authenticated reverse proxy");
  }

  const scopeValues = (env("NAVER_WORKS_SCOPES") ?? "calendar.read,contact.read,directory.read,user.profile.read")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const portValue = Number.parseInt(env("MCP_PORT") ?? "8787", 10);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error("MCP_PORT must be an integer between 1 and 65535");
  }

  return {
    apiBaseUrl: parsedBase.toString().replace(/\/$/, ""),
    accessToken: env("NAVER_WORKS_ACCESS_TOKEN"),
    authMode,
    defaultUserId: env("NAVER_WORKS_USER_ID"),
    mock,
    enforceScopes: boolEnv("NAVER_WORKS_ENFORCE_SCOPES", true),
    scopes: new Set(scopeValues),
    transport,
    host,
    port: portValue,
    sharedSecret,
    allowedHosts,
  };
}

export function publicConfig(config: AppConfig) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    apiBaseUrl: config.apiBaseUrl,
    authMode: config.authMode,
    mock: config.mock,
    enforceScopes: config.enforceScopes,
    configuredScopes: [...config.scopes].sort(),
    tokenConfigured: Boolean(config.accessToken),
    defaultUserConfigured: Boolean(config.defaultUserId),
    statelessTransport: true,
  };
}
