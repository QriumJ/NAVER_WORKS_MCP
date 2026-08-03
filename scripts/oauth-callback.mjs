import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const host = process.env.OAUTH_CALLBACK_HOST?.trim() || "127.0.0.1";
const portText = process.env.OAUTH_CALLBACK_PORT?.trim() || "8788";
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("OAUTH_CALLBACK_PORT must be an integer between 1 and 65535");
}

const redirectUri = process.env.NAVER_WORKS_REDIRECT_URI?.trim() || "http://127.0.0.1:" + port + "/callback";
const clientId = process.env.NAVER_WORKS_CLIENT_ID?.trim();
const scopes = (process.env.NAVER_WORKS_OAUTH_SCOPES?.trim() || "calendar.read directory.read user.profile.read board.read group.read group.note.read task.read bot.read orgunit.read form.read")
  .split(/[\s,]+/)
  .filter(Boolean)
  .join(" ");
const expectedState = process.env.NAVER_WORKS_OAUTH_STATE?.trim() || randomBytes(32).toString("hex");
let handled = false;

function sameSecret(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorizationUrl() {
  if (!clientId) return undefined;
  const url = new URL("https://auth.worksmobile.com/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", expectedState);
  return url.toString();
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://" + (request.headers.host || "localhost"));
  if (requestUrl.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, callbackPath: "/callback", redirectUri }));
    return;
  }
  if (requestUrl.pathname !== new URL(redirectUri).pathname) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  if (handled) {
    response.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("This OAuth callback was already used. Restart the server for a new flow.");
    return;
  }
  const error = requestUrl.searchParams.get("error");
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  if (error) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("OAuth denied: " + error);
    return;
  }
  if (!code || !state || !sameSecret(state, expectedState)) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid or missing OAuth state/code.");
    return;
  }
  handled = true;
  const codeFingerprint = createHash("sha256").update(code).digest("hex").slice(0, 12);
  console.error("[oauth] Authorization Code received (fingerprint " + codeFingerprint + "); code was not printed or stored.");
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
  response.end("<!doctype html><meta charset=\"utf-8\"><title>NAVER WORKS OAuth</title><h1>인증 코드 수신 완료</h1><p>이 창을 닫고 Hermes로 돌아가세요. Token Provider에서 Access Token 교환을 완료해야 합니다.</p>");
  setTimeout(() => server.close(() => process.exit(0)), 100);
});

server.listen(port, host, () => {
  console.error("[oauth] listening at " + redirectUri);
  console.error("[oauth] expected state: " + expectedState);
  const url = authorizationUrl();
  if (url) console.error("[oauth] open this URL in a browser:\n" + url);
  else console.error("[oauth] set NAVER_WORKS_CLIENT_ID locally to generate an authorization URL; Client Secret is not needed by this callback listener.");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
