import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHttpHandler } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { pathSegment, projectCalendarEvents, projectCalendarPersonals, projectCalendarProperties, projectUsers, rateLimitRoute, WorksApiClient } from "../src/works-api.js";

const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "contract-test", version: "0.1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function request(method: string, id: number, params: Record<string, unknown>, name?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope } }),
  });
}

describe("NAVER WORKS MCP 2026-07-28 contract", () => {
  const oldMock = process.env.NAVER_WORKS_MOCK;
  const oldScopes = process.env.NAVER_WORKS_SCOPES;
  const oldEnforceScopes = process.env.NAVER_WORKS_ENFORCE_SCOPES;
  let handler: ReturnType<typeof createHttpHandler>;

  before(() => {
    process.env.NAVER_WORKS_MOCK = "true";
    process.env.NAVER_WORKS_SCOPES = "calendar.read,directory.read,user.profile.read,board.read,group.read,group.note.read,task.read,bot.read,orgunit.read,form.read";
    process.env.NAVER_WORKS_ENFORCE_SCOPES = "true";
    handler = createHttpHandler();
  });

  after(() => {
    if (oldMock === undefined) delete process.env.NAVER_WORKS_MOCK; else process.env.NAVER_WORKS_MOCK = oldMock;
    if (oldScopes === undefined) delete process.env.NAVER_WORKS_SCOPES; else process.env.NAVER_WORKS_SCOPES = oldScopes;
    if (oldEnforceScopes === undefined) delete process.env.NAVER_WORKS_ENFORCE_SCOPES; else process.env.NAVER_WORKS_ENFORCE_SCOPES = oldEnforceScopes;
  });

  it("lists tools through a sessionless modern request", async () => {
    const response = await handler.fetch(request("tools/list", 1, {}));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);
    const payload = await response.json() as { result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>; ttlMs?: number; cacheScope?: string } };
    const names = payload.result?.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("works_health"));
    assert.ok(names.includes("works_calendar_default_events_list"));
    assert.ok(names.includes("works_board_must_read_posts_list"));
    assert.ok(names.includes("works_group_note_post_get"));
    assert.ok(names.includes("works_tasks_list"));
    assert.ok(names.includes("works_form_responses_list"));
    assert.equal(payload.result?.ttlMs, 30_000);
    assert.equal(payload.result?.cacheScope, "public");
    const usersList = payload.result?.tools?.find((tool) => tool.name === "works_directory_users_list");
    assert.equal(usersList?.inputSchema?.properties?.email, undefined);
  });

  it("executes a mock tool without a session handshake", async () => {
    const response = await handler.fetch(request("tools/call", 2, { name: "works_health", arguments: {} }, "works_health"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), null);
    const payload = await response.json() as { result?: { content?: Array<{ text?: string }> } };
    const text = payload.result?.content?.[0]?.text ?? "";
    assert.match(text, /2026-07-28/);
    assert.match(text, /statelessTransport/);
  });

  it("enforces the 31-day Calendar API window before making a request", async () => {
    const response = await handler.fetch(request("tools/call", 5, {
      name: "works_calendar_default_events_list",
      arguments: { fromDateTime: "2026-01-01T00:00:00+09:00", untilDateTime: "2026-02-15T00:00:00+09:00" },
    }, "works_calendar_default_events_list"));
    const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    assert.equal(payload.result?.isError, true);
    assert.match(payload.result?.content?.[0]?.text ?? "", /31일/);
  });

  it("requires the official Calendar date-time shape", async () => {
    const response = await handler.fetch(request("tools/call", 17, {
      name: "works_calendar_default_events_list",
      arguments: { fromDateTime: "2026-01-01", untilDateTime: "2026-01-02" },
    }, "works_calendar_default_events_list"));
    const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    assert.equal(payload.result?.isError, true);
    assert.match(payload.result?.content?.[0]?.text ?? "", /YYYY-MM-DDThh:mm:ssTZD/);
  });

  it("blocks userId=me for Service Account mode", async () => {
    const oldAuthMode = process.env.NAVER_WORKS_AUTH_MODE;
    process.env.NAVER_WORKS_AUTH_MODE = "service_account";
    try {
      const response = await handler.fetch(request("tools/call", 6, { name: "works_directory_user_profile_get", arguments: { userId: "me" } }, "works_directory_user_profile_get"));
      const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      assert.equal(payload.result?.isError, true);
      assert.match(payload.result?.content?.[0]?.text ?? "", /userId=me/);
    } finally {
      if (oldAuthMode === undefined) delete process.env.NAVER_WORKS_AUTH_MODE; else process.env.NAVER_WORKS_AUTH_MODE = oldAuthMode;
    }
  });

  it("rejects a legacy initialize request on the strict HTTP endpoint", async () => {
    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "initialize" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }),
    }));
    assert.equal(response.status, 400);
  });

  it("rejects unsafe URL path identifiers before interpolation", () => {
    assert.throws(() => pathSegment("../../etc", "userId"));
    assert.throws(() => pathSegment("victim#", "userId"));
    assert.equal(pathSegment("user@example.com", "userId"), "user%40example.com");
  });

  it("fails closed when an upstream projection payload is not an object", () => {
    assert.deepEqual(projectCalendarEvents("unexpected"), { events: [] });
    assert.deepEqual(projectUsers(42), { users: [] });
  });

  it("projects calendar properties without member identifiers or calendar email", () => {
    const projected = projectCalendarProperties({
      calendarId: "cal-1",
      calendarName: "Default",
      calendarEmail: "calendar@example.com",
      isPublic: false,
      type: "INDIVIDUAL",
      members: [{ id: "member-1", role: "OWNER" }],
    }) as Record<string, unknown>;
    assert.deepEqual(projected, { calendarId: "cal-1", calendarName: "Default", isPublic: false, type: "INDIVIDUAL", responseMetaData: undefined });
    assert.equal("calendarEmail" in projected, false);
    assert.equal("members" in projected, false);
  });

  it("projects calendar personals to the documented minimal fields", () => {
    const projected = projectCalendarPersonals({
      calendarPersonals: [{ calendarId: "cal-1", calendarName: "Default", isShowOnLNBList: true, displayOrder: 0, calendarEmail: "calendar@example.com" }],
    }) as { calendarPersonals: Array<Record<string, unknown>> };
    assert.deepEqual(projected.calendarPersonals[0], { calendarId: "cal-1", calendarName: "Default", isShowOnLNBList: true, displayOrder: 0 });
    assert.equal("calendarEmail" in projected.calendarPersonals[0], false);
  });

  it("projects nested users without leaking org-unit metadata", () => {
    const projected = projectUsers({
      users: [{
        userId: "u-1",
        email: "user@example.com",
        userName: { lastName: "홍", firstName: "길동", privateNote: "ignore" },
        organizations: [{
          domainId: 1,
          primary: true,
          organizationName: "Example",
          orgUnits: [{ orgUnitId: "ou-1", orgUnitName: "기획", orgUnitEmail: "private@example.com", externalKey: "secret" }],
        }],
      }],
    }) as { users: Array<Record<string, unknown>> };
    const user = projected.users[0];
    const organization = (user.organizations as Array<Record<string, unknown>>)[0];
    const unit = (organization.orgUnits as Array<Record<string, unknown>>)[0];
    assert.deepEqual(unit, { orgUnitId: "ou-1", orgUnitName: "기획" });
    assert.doesNotMatch(JSON.stringify(projected), /private@example\.com|externalKey|privateNote/);
  });

  it("returns the mock profile shape for a profile lookup", async () => {
    const response = await handler.fetch(request("tools/call", 7, { name: "works_directory_user_profile_get", arguments: { userId: "mock-user" } }, "works_directory_user_profile_get"));
    const payload = await response.json() as { result?: { content?: Array<{ text?: string }> } };
    const text = payload.result?.content?.[0]?.text ?? "";
    assert.match(text, /mock-user/);
    assert.match(text, /사용자/);
  });

  it("reads a mock board announcement list and body", async () => {
    const list = await handler.fetch(request("tools/call", 23, { name: "works_board_must_read_posts_list", arguments: {} }, "works_board_must_read_posts_list"));
    const listPayload = await list.json() as { result?: { content?: Array<{ text?: string }> } };
    assert.match(listPayload.result?.content?.[0]?.text ?? "", /MCP mock/);
    const body = await handler.fetch(request("tools/call", 24, { name: "works_board_post_get", arguments: { boardId: 100, postId: 1 } }, "works_board_post_get"));
    const bodyPayload = await body.json() as { result?: { content?: Array<{ text?: string }> } };
    assert.match(bodyPayload.result?.content?.[0]?.text ?? "", /모의 공지 본문/);
  });

  it("reads mock group-note notices, tasks, bots, org units, and forms", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["works_group_note_posts_list", { groupId: "mock-group" }],
      ["works_tasks_list", { categoryId: "default", userId: "mock-user" }],
      ["works_task_get", { taskId: "mock-task" }],
      ["works_bots_list", {}],
      ["works_orgunits_list", {}],
      ["works_form_responses_list", { formId: "mock-form" }],
    ];
    for (const [name, arguments_] of calls) {
      const response = await handler.fetch(request("tools/call", 25, { name, arguments: arguments_ }, name));
      const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      assert.notEqual(payload.result?.isError, true, name);
      assert.ok(payload.result?.content?.[0]?.text, name);
    }
    const formDefault = await handler.fetch(request("tools/call", 26, { name: "works_form_responses_list", arguments: { formId: "mock-form" } }, "works_form_responses_list"));
    const formDefaultPayload = await formDefault.json() as { result?: { content?: Array<{ text?: string }> } };
    assert.doesNotMatch(formDefaultPayload.result?.content?.[0]?.text ?? "", /모의 응답/);
    const formOptIn = await handler.fetch(request("tools/call", 27, { name: "works_form_responses_list", arguments: { formId: "mock-form", includeAnswers: true, includeRespondent: true } }, "works_form_responses_list"));
    const formOptInPayload = await formOptIn.json() as { result?: { content?: Array<{ text?: string }> } };
    assert.match(formOptInPayload.result?.content?.[0]?.text ?? "", /모의 응답/);
  });

  it("blocks Service Account task-category paths", async () => {
    const api = new WorksApiClient({
      apiBaseUrl: "https://example.test/v1.0",
      accessToken: "test-token",
      authMode: "service_account",
      mock: false,
      enforceScopes: false,
      scopes: new Set(),
      transport: "stdio",
      host: "127.0.0.1",
      port: 8787,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    });
    await assert.rejects(api.request("GET", "/users/user-1/task-categories"), /Service Account/);
  });

  it("normalizes user and calendar identifiers for the Free-plan rate bucket", () => {
    assert.equal(rateLimitRoute("/users/alice/calendar/events"), "/users/:user/calendar/events");
    assert.equal(rateLimitRoute("/users/alice/calendars/cal-1/events"), "/users/:user/calendars/:calendar/events");
  });

  it("counts each read-only retry as a physical upstream attempt", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls < 3 ? new Response("temporary", { status: 503 }) : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const api = new WorksApiClient({
        apiBaseUrl: "https://example.test/v1.0",
        accessToken: "test-token",
        authMode: "user_oauth",
        mock: false,
        enforceScopes: false,
        scopes: new Set(),
        transport: "stdio",
        host: "127.0.0.1",
        port: 8787,
        allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      });
      await api.request("GET", "/retry-attempt-contract");
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed on an oversized upstream response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 })) as typeof fetch;
    try {
      const api = new WorksApiClient({
        apiBaseUrl: "https://example.test/v1.0",
        accessToken: "test-token",
        authMode: "user_oauth",
        mock: false,
        enforceScopes: false,
        scopes: new Set(),
        transport: "stdio",
        host: "127.0.0.1",
        port: 8787,
        allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      });
      await assert.rejects(api.request("GET", "/oversized-response-contract"), /허용 크기/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects remote HTTP binding without a shared secret", () => {
    const oldTransport = process.env.MCP_TRANSPORT;
    const oldHost = process.env.MCP_HOST;
    const oldSecret = process.env.MCP_SHARED_SECRET;
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HOST = "0.0.0.0";
    delete process.env.MCP_SHARED_SECRET;
    try {
      assert.throws(() => loadConfig(), /MCP_SHARED_SECRET/);
    } finally {
      if (oldTransport === undefined) delete process.env.MCP_TRANSPORT; else process.env.MCP_TRANSPORT = oldTransport;
      if (oldHost === undefined) delete process.env.MCP_HOST; else process.env.MCP_HOST = oldHost;
      if (oldSecret === undefined) delete process.env.MCP_SHARED_SECRET; else process.env.MCP_SHARED_SECRET = oldSecret;
    }
  });

  it("rejects live HTTP API bases that are not HTTPS", () => {
    const oldMock = process.env.NAVER_WORKS_MOCK;
    const oldBase = process.env.NAVER_WORKS_API_BASE;
    process.env.NAVER_WORKS_MOCK = "false";
    process.env.NAVER_WORKS_API_BASE = "http://example.test/v1.0";
    try {
      assert.throws(() => loadConfig(), /HTTPS/);
    } finally {
      if (oldMock === undefined) delete process.env.NAVER_WORKS_MOCK; else process.env.NAVER_WORKS_MOCK = oldMock;
      if (oldBase === undefined) delete process.env.NAVER_WORKS_API_BASE; else process.env.NAVER_WORKS_API_BASE = oldBase;
    }
  });

  it("rejects weak remote shared secrets", () => {
    const oldTransport = process.env.MCP_TRANSPORT;
    const oldHost = process.env.MCP_HOST;
    const oldSecret = process.env.MCP_SHARED_SECRET;
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HOST = "0.0.0.0";
    process.env.MCP_SHARED_SECRET = "short";
    try {
      assert.throws(() => loadConfig(), /32 characters/);
    } finally {
      if (oldTransport === undefined) delete process.env.MCP_TRANSPORT; else process.env.MCP_TRANSPORT = oldTransport;
      if (oldHost === undefined) delete process.env.MCP_HOST; else process.env.MCP_HOST = oldHost;
      if (oldSecret === undefined) delete process.env.MCP_SHARED_SECRET; else process.env.MCP_SHARED_SECRET = oldSecret;
    }
  });

  it("rejects malformed boolean security configuration instead of failing open", () => {
    const oldValue = process.env.NAVER_WORKS_ENFORCE_SCOPES;
    process.env.NAVER_WORKS_ENFORCE_SCOPES = "tru";
    try {
      assert.throws(() => loadConfig(), /NAVER_WORKS_ENFORCE_SCOPES/);
    } finally {
      if (oldValue === undefined) delete process.env.NAVER_WORKS_ENFORCE_SCOPES; else process.env.NAVER_WORKS_ENFORCE_SCOPES = oldValue;
    }
  });
});
