import type { AppConfig } from "./config.js";

export interface ApiResponse<T> {
  data: T;
  status: number;
  rateLimit?: {
    limit?: string;
    remaining?: string;
    resetSeconds?: string;
  };
}

export class WorksApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "WorksApiError";
  }
}

/** Validate and encode an identifier before placing it in a URL path. */
export function pathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value) || value === "." || value === "..") {
    throw new WorksApiError(`${label}에 허용되지 않는 문자가 포함되어 있습니다.`);
  }
  return encodeURIComponent(value);
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

class SlidingWindow {
  private readonly calls: number[] = [];

  async wait(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (this.calls[0] !== undefined && now - this.calls[0] >= 60_000) this.calls.shift();
      if (this.calls.length < 60) {
        this.calls.push(now);
        return;
      }
      const waitMs = Math.max(25, 60_000 - (now - (this.calls[0] ?? now)) + 10);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const SERVICE_ACCOUNT_PROHIBITED = [
  /^\/tasks(?:\/|$)/,
  /^\/task-categories(?:\/|$)/,
  /^\/forms(?:\/|$)/,
  /^\/users\/[^/]+\/tasks(?:\/|$)/,
  /^\/users\/[^/]+\/task-categories(?:\/|$)/,
  /^\/users\/[^/]+\/mail(?:\/|$)/,
  /^\/users\/[^/]+\/drive(?:\/|$)/,
  /^\/sharedrives(?:\/|$)/,
  /^\/groups\/[^/]+\/note(?:\/|$)/,
  /^\/groups\/[^/]+\/folder(?:\/|$)/,
];

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WorksApiError(`NAVER WORKS API 응답이 허용 크기(${MAX_API_RESPONSE_BYTES} bytes)를 초과했습니다.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function rateLimitRoute(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "users") return `/${parts[0] ?? "root"}`;
  if (parts.length === 1) return "/users";
  if (parts[2] === "calendar" || parts[2] === "calendar-personals" || parts[2] === "contacts") {
    return `/users/:user/${parts.slice(2).join("/")}`;
  }
  if (parts[2] === "calendars") return "/users/:user/calendars/:calendar/events";
  return "/users/:user";
}

function maskEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.includes("@")) return undefined;
  const [local, domain] = value.split("@", 2);
  if (!local || !domain) return undefined;
  return `${local.slice(0, 1)}***@${domain}`;
}

function maskTelephone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function projectEvent(event: unknown) {
  const eventRecord = asRecord(event) ?? {};
  const start = asRecord(eventRecord.start);
  const end = asRecord(eventRecord.end);
  const projectTime = (value: Record<string, unknown> | undefined) => value ? {
    dateTime: typeof value.dateTime === "string" ? value.dateTime : undefined,
    date: typeof value.date === "string" ? value.date : undefined,
    timeZone: typeof value.timeZone === "string" ? value.timeZone : undefined,
  } : undefined;
  return {
    eventId: typeof eventRecord.eventId === "string" ? eventRecord.eventId : undefined,
    summary: typeof eventRecord.summary === "string" ? eventRecord.summary : undefined,
    start: projectTime(start),
    end: projectTime(end),
    location: typeof eventRecord.location === "string" ? eventRecord.location : undefined,
    transparency: typeof eventRecord.transparency === "string" ? eventRecord.transparency : undefined,
  };
}

export function projectCalendarEvents(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return { events: [] };
  const root = payload as Record<string, unknown>;
  const components = Array.isArray(root.eventComponents) ? root.eventComponents : undefined;
  const events = Array.isArray(root.events) ? root.events : undefined;
  if (components) return { eventComponents: components.map((item) => projectEvent(item)) };
  if (events) {
    const projected = events.flatMap((item) => {
      const value = asRecord(item) ?? {};
      const nested = Array.isArray(value.eventComponents) ? value.eventComponents : undefined;
      return nested ? nested.map((event) => projectEvent(event)) : [projectEvent(value)];
    });
    return { events: projected, responseMetaData: projectResponseMetaData(root.responseMetaData) };
  }
  return { events: [], responseMetaData: projectResponseMetaData(root.responseMetaData) };
}

function projectResponseMetaData(value: unknown): { nextCursor?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nextCursor = (value as Record<string, unknown>).nextCursor;
  return typeof nextCursor === "string" ? { nextCursor } : undefined;
}

export function projectCalendarProperties(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  return {
    calendarId: typeof root.calendarId === "string" ? root.calendarId : undefined,
    calendarName: typeof root.calendarName === "string" ? root.calendarName : undefined,
    isPublic: typeof root.isPublic === "boolean" ? root.isPublic : undefined,
    type: typeof root.type === "string" ? root.type : undefined,
    responseMetaData: projectResponseMetaData(root.responseMetaData),
  };
}

export function projectCalendarPersonals(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return { calendarPersonals: [] };
  const root = payload as Record<string, unknown>;
  const personals = Array.isArray(root.calendarPersonals) ? root.calendarPersonals : [];
  return {
    calendarPersonals: personals.map((item) => {
      const personal = asRecord(item) ?? {};
      return {
        calendarId: typeof personal.calendarId === "string" ? personal.calendarId : undefined,
        calendarName: typeof personal.calendarName === "string" ? personal.calendarName : undefined,
        isShowOnLNBList: typeof personal.isShowOnLNBList === "boolean" ? personal.isShowOnLNBList : undefined,
        displayOrder: typeof personal.displayOrder === "number" ? personal.displayOrder : undefined,
      };
    }),
    responseMetaData: projectResponseMetaData(root.responseMetaData),
  };
}

export function projectContacts(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return { contacts: [] };
  const root = payload as Record<string, unknown>;
  const contacts = Array.isArray(root.contacts) ? root.contacts : [];
  return {
    contacts: contacts.map((item) => {
      const contact = asRecord(item) ?? {};
      const name = asRecord(contact.contactName) ?? {};
      const emails = Array.isArray(contact.emails) ? contact.emails : [];
      const telephones = Array.isArray(contact.telephones) ? contact.telephones : [];
      const organizations = Array.isArray(contact.organizations) ? contact.organizations : [];
      return {
        contactId: typeof contact.contactId === "string" ? contact.contactId : undefined,
        contactName: {
          lastName: typeof name.lastName === "string" ? name.lastName : undefined,
          firstName: typeof name.firstName === "string" ? name.firstName : undefined,
          nickName: typeof name.nickName === "string" ? name.nickName : undefined,
        },
        emails: emails
          .map((email) => asRecord(email))
          .filter((email): email is Record<string, unknown> => email?.primary === true)
          .slice(0, 1)
          .map((email) => ({ primary: true, email: maskEmail(email.email) })),
        telephones: telephones
          .map((telephone) => asRecord(telephone))
          .filter((telephone): telephone is Record<string, unknown> => telephone?.primary === true)
          .slice(0, 1)
          .map((telephone) => ({ primary: true, telephone: maskTelephone(telephone.telephone) })),
        organizations: organizations.slice(0, 3).map((organization) => {
          const value = asRecord(organization) ?? {};
          return {
            name: typeof value.name === "string" ? value.name : undefined,
            department: typeof value.department === "string" ? value.department : undefined,
            title: typeof value.title === "string" ? value.title : undefined,
          };
        }),
      };
    }),
    responseMetaData: projectResponseMetaData(root.responseMetaData),
  };
}

export function projectUsers(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return { users: [] };
  const root = payload as Record<string, unknown>;
  const users = Array.isArray(root.users) ? root.users : [];
  return {
    users: users.map((item) => {
      const user = asRecord(item) ?? {};
      const name = asRecord(user.userName) ?? {};
      const organizations = Array.isArray(user.organizations) ? user.organizations : [];
      return {
        userId: typeof user.userId === "string" ? user.userId : undefined,
        email: maskEmail(user.email),
        userName: {
          lastName: typeof name.lastName === "string" ? name.lastName : undefined,
          firstName: typeof name.firstName === "string" ? name.firstName : undefined,
        },
        nickName: typeof user.nickName === "string" ? user.nickName : undefined,
        isAdministrator: typeof user.isAdministrator === "boolean" ? user.isAdministrator : undefined,
        isSuspended: typeof user.isSuspended === "boolean" ? user.isSuspended : undefined,
        organizations: organizations.slice(0, 5).map((organization) => {
          const value = asRecord(organization) ?? {};
          const orgUnits = Array.isArray(value.orgUnits) ? value.orgUnits.slice(0, 10) : [];
          return {
            domainId: typeof value.domainId === "number" ? value.domainId : undefined,
            primary: typeof value.primary === "boolean" ? value.primary : undefined,
            organizationName: typeof value.organizationName === "string" ? value.organizationName : undefined,
            orgUnits: orgUnits.flatMap((unit) => {
              const unitRecord = asRecord(unit);
              if (!unitRecord) return [];
              return [{
                orgUnitId: typeof unitRecord.orgUnitId === "string" ? unitRecord.orgUnitId : undefined,
                orgUnitName: typeof unitRecord.orgUnitName === "string" ? unitRecord.orgUnitName : undefined,
              }];
            }),
          };
        }),
      };
    }),
    responseMetaData: projectResponseMetaData(root.responseMetaData),
  };
}

const MOCK = {
  calendar: { calendarId: "mock-calendar", calendarName: "기본 캘린더", isPublic: false, type: "INDIVIDUAL", members: [] },
  personals: { calendarPersonals: [{ calendarId: "mock-calendar", calendarName: "기본 캘린더", isShowOnLNBList: true, displayOrder: 0 }], responseMetaData: { nextCursor: "" } },
  events: { events: [{ eventComponents: [{ eventId: "mock-event", summary: "MCP mock 일정", start: { dateTime: "2026-08-03T09:00:00+09:00", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-08-03T10:00:00+09:00", timeZone: "Asia/Seoul" }, location: "온라인" }] }], responseMetaData: { nextCursor: "" } },
  contacts: { contacts: [{ contactId: "mock-contact", contactName: { lastName: "홍", firstName: "길동" }, emails: [{ primary: true, email: "hong@example.com" }], telephones: [{ primary: true, telephone: "010-1234-5678" }], organizations: [{ name: "예시회사", department: "기획", title: "담당자" }] }], responseMetaData: { nextCursor: "" } },
  users: { users: [{ userId: "mock-user", email: "user@example.com", userName: { lastName: "MCP", firstName: "사용자" }, organizations: [] }], responseMetaData: { nextCursor: "" } },
};

// Stateless MCP creates a client per request. Keep the Free-plan guards at
// module scope so all requests in this process share one 5-concurrent/60 rpm
// limiter. Multi-replica deployments still need a shared limiter (Redis, etc.).
const GLOBAL_SEMAPHORE = new Semaphore(5);
const GLOBAL_WINDOWS = new Map<string, SlidingWindow>();

export class WorksApiClient {
  constructor(private readonly config: AppConfig) {}

  getUserId(userId?: string): string {
    const resolved = userId ?? this.config.defaultUserId ?? (this.config.mock ? "mock-user" : undefined);
    if (!resolved) throw new WorksApiError("userId가 필요합니다. NAVER_WORKS_USER_ID를 설정하거나 Tool 인자로 전달하세요.");
    if (this.config.authMode === "service_account" && resolved === "me") {
      throw new WorksApiError("Service Account에서는 userId=me를 사용할 수 없습니다.");
    }
    return resolved;
  }

  async request<T>(method: string, path: string, options: { query?: Record<string, string | number | undefined>; requiredScopes?: string[]; readOnly?: boolean; body?: unknown } = {}): Promise<ApiResponse<T>> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const readOnly = options.readOnly ?? method.toUpperCase() === "GET";
    if (this.config.authMode === "service_account" && SERVICE_ACCOUNT_PROHIBITED.some((pattern) => pattern.test(normalizedPath))) {
      throw new WorksApiError(`Service Account에서 금지된 NAVER WORKS API 경로입니다: ${normalizedPath}`);
    }
    if (this.config.enforceScopes && options.requiredScopes?.length) {
      const missing = options.requiredScopes.filter((scope) => !this.config.scopes.has(scope));
      if (missing.length) throw new WorksApiError(`필수 Scope가 로컬 정책에 없습니다: ${missing.join(", ")}`);
    }
    if (this.config.mock) return this.mockRequest<T>(normalizedPath);
    if (!this.config.accessToken) throw new WorksApiError("NAVER_WORKS_ACCESS_TOKEN이 설정되지 않았습니다.");

    const key = `${method.toUpperCase()} ${rateLimitRoute(normalizedPath)}`;
    const window = GLOBAL_WINDOWS.get(key) ?? new SlidingWindow();
    GLOBAL_WINDOWS.set(key, window);
    const release = await GLOBAL_SEMAPHORE.acquire();
    try {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== "") query.set(name, String(value));
      const url = new URL(`${this.config.apiBaseUrl}${normalizedPath}`);
      url.search = query.toString();
      const maxAttempts = readOnly ? 3 : 1;
      let lastError: WorksApiError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await window.wait();
        try {
          const response = await fetch(url, {
            method: method.toUpperCase(),
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.config.accessToken}`,
              ...(options.body === undefined ? {} : { "Content-Type": "application/json; charset=UTF-8" }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: AbortSignal.timeout(15_000),
          });
          const raw = await readResponseText(response);
          let data: unknown = null;
          if (raw) {
            try { data = JSON.parse(raw); } catch { data = raw; }
          }
          if (response.ok) {
            return {
              data: data as T,
              status: response.status,
              rateLimit: {
                limit: response.headers.get("rateLimit-limit") ?? undefined,
                remaining: response.headers.get("rateLimit-remaining") ?? undefined,
                resetSeconds: response.headers.get("rateLimit-reset") ?? undefined,
              },
            };
          }
          const errorBody = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
          const error = new WorksApiError(
            typeof errorBody?.description === "string" ? errorBody.description : `NAVER WORKS API ${response.status}`,
            response.status,
            typeof errorBody?.code === "string" ? errorBody.code : undefined,
          );
          if (!readOnly || ![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) throw error;
          lastError = error;
          const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "");
          const rateLimitReset = Number.parseFloat(response.headers.get("rateLimit-reset") ?? "");
          const retryAfterMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0;
          const rateLimitResetMs = Number.isFinite(rateLimitReset) ? Math.max(0, rateLimitReset * 1000) : 0;
          await sleep(Math.min(60_000, Math.max(attempt * 750, retryAfterMs, rateLimitResetMs)));
        } catch (error) {
          if (error instanceof WorksApiError) throw error;
          if (attempt === maxAttempts) throw new WorksApiError(error instanceof Error ? error.message : "NAVER WORKS API 요청 실패");
          lastError = new WorksApiError(error instanceof Error ? error.message : "NAVER WORKS API 요청 실패");
          await sleep(attempt * 750);
        }
      }
      throw lastError ?? new WorksApiError("NAVER WORKS API 요청 실패");
    } finally {
      release();
    }
  }

  private async mockRequest<T>(path: string): Promise<ApiResponse<T>> {
    await Promise.resolve();
    if (path.endsWith("/calendar")) return { data: MOCK.calendar as T, status: 200 };
    if (path.endsWith("/calendar-personals")) return { data: MOCK.personals as T, status: 200 };
    if (path.includes("/calendar/events") || path.includes("/calendars/")) return { data: MOCK.events as T, status: 200 };
    if (path.includes("/contacts/search")) return { data: MOCK.contacts as T, status: 200 };
    if (path === "/users") return { data: MOCK.users as T, status: 200 };
    if (/^\/users\/[^/]+$/.test(path)) return { data: MOCK.users.users[0] as T, status: 200 };
    return { data: {} as T, status: 200 };
  }
}

export function validateDateRange(fromDateTime: string, untilDateTime: string): void {
  if (!DATE_TIME_PATTERN.test(fromDateTime) || !DATE_TIME_PATTERN.test(untilDateTime)) {
    throw new WorksApiError("날짜·시간은 YYYY-MM-DDThh:mm:ssTZD 형식이어야 합니다.");
  }
  const from = new Date(fromDateTime);
  const until = new Date(untilDateTime);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until <= from) throw new WorksApiError("fromDateTime과 untilDateTime은 유효한 시간 범위여야 합니다.");
  const days = (until.getTime() - from.getTime()) / 86_400_000;
  if (days > 31) throw new WorksApiError("NAVER WORKS 일정 목록 API의 최대 조회 범위(31일)를 초과했습니다.");
}
