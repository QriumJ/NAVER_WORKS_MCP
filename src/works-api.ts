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
  if (parts[0] === "boards") {
    if (parts[1] === "recent" || parts[1] === "my" || parts[1] === "must") return "/boards/:collection/posts";
    if (parts[2] === "posts") return "/boards/:board/posts";
    return "/boards";
  }
  if (parts[0] === "groups") {
    if (parts[2] === "note") return "/groups/:group/note";
    if (parts[2] === "members") return "/groups/:group/members";
    if (parts[2] === "administrators") return "/groups/:group/administrators";
    if (parts[2] === "folder") return "/groups/:group/folder";
    return "/groups";
  }
  if (parts[0] === "tasks") return "/tasks/:task";
  if (parts[0] === "forms") return "/forms/:form/responses";
  if (parts[0] === "bots") return "/bots/:bot";
  if (parts[0] === "orgunits") return "/orgunits";
  if (parts[0] === "contacts") return parts[1] ? "/contacts/:contact" : "/contacts";
  if (parts[0] !== "users") return `/${parts[0] ?? "root"}`;
  if (parts.length === 1) return "/users";
  if (parts[2] === "calendar" || parts[2] === "calendar-personals") {
    return `/users/:user/${parts.slice(2).join("/")}`;
  }
  if (parts[2] === "tasks" || parts[2] === "task-categories") return `/users/:user/${parts[2]}`;
  if (parts[2] === "contacts") return "/users/:user/contacts";
  if (parts[2] === "calendars") return "/users/:user/calendars/:calendar/events";
  return "/users/:user";
}

function maskEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.includes("@")) return undefined;
  const [local, domain] = value.split("@", 2);
  if (!local || !domain) return undefined;
  return `${local.slice(0, 1)}***@${domain}`;
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

function projectContactItem(value: unknown) {
  const contact = asRecord(value) ?? {};
  const name = asRecord(contact.contactName) ?? {};
  const permission = asRecord(contact.permission) ?? {};
  const linkedExternalUser = asRecord(contact.linkedExternalUser);
  const emails = Array.isArray(contact.emails) ? contact.emails : [];
  const telephones = Array.isArray(contact.telephones) ? contact.telephones : [];
  const organizations = Array.isArray(contact.organizations) ? contact.organizations : [];
  const primaryValue = (values: unknown[]) => {
    const records = values.flatMap((item) => {
      const record = asRecord(item);
      return record ? [record] : [];
    });
    return records.find((record) => record.primary === true) ?? records[0];
  };
  const primaryEmail = primaryValue(emails);
  const primaryTelephone = primaryValue(telephones);
  const primaryOrganization = primaryValue(organizations);
  return {
    contactId: typeof contact.contactId === "string" ? contact.contactId : undefined,
    contactName: {
      firstName: typeof name.firstName === "string" ? name.firstName : undefined,
      lastName: typeof name.lastName === "string" ? name.lastName : undefined,
      nickName: typeof name.nickName === "string" ? name.nickName : undefined,
    },
    email: maskEmail(primaryEmail?.email),
    telephone: typeof primaryTelephone?.telephone === "string" ? primaryTelephone.telephone : undefined,
    organization: primaryOrganization ? {
      name: typeof primaryOrganization.name === "string" ? primaryOrganization.name : undefined,
      department: typeof primaryOrganization.department === "string" ? primaryOrganization.department : undefined,
      title: typeof primaryOrganization.title === "string" ? primaryOrganization.title : undefined,
    } : undefined,
    permission: typeof permission.accessibleRange === "string" ? { accessibleRange: permission.accessibleRange } : undefined,
    linkedExternalUser: linkedExternalUser && typeof linkedExternalUser.type === "string" ? { type: linkedExternalUser.type } : undefined,
  };
}

export function projectContacts(payload: unknown): unknown {
  return projectList(payload, "contacts", projectContactItem);
}

export function projectContact(payload: unknown): unknown {
  return projectContactItem(payload);
}

function projectList<T>(payload: unknown, key: string, itemProject: (value: unknown) => T): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return { [key]: [] };
  const root = payload as Record<string, unknown>;
  const values = Array.isArray(root[key]) ? root[key] : [];
  return { [key]: values.map(itemProject), responseMetaData: projectResponseMetaData(root.responseMetaData) };
}

function projectBoardItem(value: unknown) {
  const board = asRecord(value) ?? {};
  return {
    boardId: typeof board.boardId === "number" ? board.boardId : undefined,
    boardName: typeof board.boardName === "string" ? board.boardName : undefined,
    description: typeof board.description === "string" ? board.description : undefined,
    createdTime: typeof board.createdTime === "string" ? board.createdTime : undefined,
    modifiedTime: typeof board.modifiedTime === "string" ? board.modifiedTime : undefined,
    displayOrder: typeof board.displayOrder === "number" ? board.displayOrder : undefined,
  };
}

function projectBoardPostItem(value: unknown, includeBody = false) {
  const post = asRecord(value) ?? {};
  const mustReadPeriod = asRecord(post.mustReadPeriod);
  return {
    boardId: typeof post.boardId === "number" ? post.boardId : undefined,
    postId: typeof post.postId === "number" ? post.postId : undefined,
    title: typeof post.title === "string" ? post.title : undefined,
    ...(includeBody ? { body: typeof post.body === "string" ? post.body : undefined } : {}),
    readCount: typeof post.readCount === "number" ? post.readCount : undefined,
    commentCount: typeof post.commentCount === "number" ? post.commentCount : undefined,
    fileCount: typeof post.fileCount === "number" ? post.fileCount : undefined,
    createdTime: typeof post.createdTime === "string" ? post.createdTime : undefined,
    modifiedTime: typeof post.modifiedTime === "string" ? post.modifiedTime : undefined,
    isMustRead: typeof post.isMustRead === "boolean" ? post.isMustRead : undefined,
    mustReadPeriod: mustReadPeriod ? {
      startDate: typeof mustReadPeriod.startDate === "string" ? mustReadPeriod.startDate : undefined,
      endDate: typeof mustReadPeriod.endDate === "string" ? mustReadPeriod.endDate : undefined,
    } : undefined,
    isUnread: typeof post.isUnread === "boolean" ? post.isUnread : undefined,
    userName: typeof post.userName === "string" ? post.userName : undefined,
  };
}

export function projectBoards(payload: unknown): unknown {
  return projectList(payload, "boards", projectBoardItem);
}

export function projectBoard(payload: unknown): unknown {
  return projectBoardItem(payload);
}

export function projectBoardPosts(payload: unknown): unknown {
  return projectList(payload, "posts", (value) => projectBoardPostItem(value));
}

export function projectBoardPost(payload: unknown): unknown {
  return projectBoardPostItem(payload, true);
}

function projectNotePostItem(value: unknown, includeBody = false) {
  const post = asRecord(value) ?? {};
  return {
    postId: typeof post.postId === "number" ? post.postId : undefined,
    title: typeof post.title === "string" ? post.title : undefined,
    ...(includeBody ? { body: typeof post.body === "string" ? post.body : undefined } : {}),
    enableCollaboration: typeof post.enableCollaboration === "boolean" ? post.enableCollaboration : undefined,
    readCount: typeof post.readCount === "number" ? post.readCount : undefined,
    commentCount: typeof post.commentCount === "number" ? post.commentCount : undefined,
    fileCount: typeof post.fileCount === "number" ? post.fileCount : undefined,
    likeCount: typeof post.likeCount === "number" ? post.likeCount : undefined,
    createdTime: typeof post.createdTime === "string" ? post.createdTime : undefined,
    modifiedTime: typeof post.modifiedTime === "string" ? post.modifiedTime : undefined,
    userId: typeof post.userId === "string" ? post.userId : undefined,
    userName: typeof post.userName === "string" ? post.userName : undefined,
    isNotice: typeof post.isNotice === "boolean" ? post.isNotice : undefined,
  };
}

export function projectNotePosts(payload: unknown): unknown {
  return projectList(payload, "posts", (value) => projectNotePostItem(value));
}

export function projectNotePost(payload: unknown): unknown {
  return projectNotePostItem(payload, true);
}

function projectGroupItem(value: unknown) {
  const group = asRecord(value) ?? {};
  return {
    domainId: typeof group.domainId === "number" ? group.domainId : undefined,
    groupId: typeof group.groupId === "string" ? group.groupId : undefined,
    groupName: typeof group.groupName === "string" ? group.groupName : undefined,
    description: typeof group.description === "string" ? group.description : undefined,
    visible: typeof group.visible === "boolean" ? group.visible : undefined,
    useMessage: typeof group.useMessage === "boolean" ? group.useMessage : undefined,
    useNote: typeof group.useNote === "boolean" ? group.useNote : undefined,
    useCalendar: typeof group.useCalendar === "boolean" ? group.useCalendar : undefined,
    useTask: typeof group.useTask === "boolean" ? group.useTask : undefined,
    useFolder: typeof group.useFolder === "boolean" ? group.useFolder : undefined,
  };
}

export function projectGroups(payload: unknown): unknown {
  return projectList(payload, "groups", projectGroupItem);
}

export function projectGroup(payload: unknown): unknown {
  return projectGroupItem(payload);
}

export function projectGroupMembers(payload: unknown): unknown {
  return projectList(payload, "members", (value) => {
    const member = asRecord(value) ?? {};
    return {
      id: typeof member.id === "string" ? member.id : undefined,
      type: typeof member.type === "string" ? member.type : undefined,
    };
  });
}

function projectTaskItem(value: unknown) {
  const task = asRecord(value) ?? {};
  const assignees = Array.isArray(task.assignees) ? task.assignees : [];
  return {
    taskId: typeof task.taskId === "string" ? task.taskId : undefined,
    title: typeof task.title === "string" ? task.title : undefined,
    content: typeof task.content === "string" ? task.content : undefined,
    dueDate: typeof task.dueDate === "string" ? task.dueDate : null,
    status: typeof task.status === "string" ? task.status : undefined,
    createdTime: typeof task.createdTime === "string" ? task.createdTime : undefined,
    modifiedTime: typeof task.modifiedTime === "string" ? task.modifiedTime : undefined,
    assignorName: typeof task.assignorName === "string" ? task.assignorName : undefined,
    completionCondition: typeof task.completionCondition === "string" ? task.completionCondition : undefined,
    assignees: assignees.slice(0, 20).flatMap((item) => {
      const assignee = asRecord(item);
      return assignee ? [{
        assigneeId: typeof assignee.assigneeId === "string" ? assignee.assigneeId : undefined,
        assigneeName: typeof assignee.assigneeName === "string" ? assignee.assigneeName : undefined,
        status: typeof assignee.status === "string" ? assignee.status : undefined,
      }] : [];
    }),
  };
}

export function projectTasks(payload: unknown): unknown {
  return projectList(payload, "tasks", projectTaskItem);
}

export function projectTask(payload: unknown): unknown {
  const root = asRecord(payload);
  return projectTaskItem(root?.task ?? payload);
}

export function projectTaskCategories(payload: unknown): unknown {
  return projectList(payload, "taskCategories", (value) => {
    const category = asRecord(value) ?? {};
    return {
      categoryId: typeof category.categoryId === "string" ? category.categoryId : undefined,
      categoryName: typeof category.categoryName === "string" ? category.categoryName : undefined,
    };
  });
}

export function projectBots(payload: unknown): unknown {
  return projectList(payload, "bots", (value) => {
    const bot = asRecord(value) ?? {};
    return {
      botId: typeof bot.botId === "number" ? bot.botId : undefined,
      botName: typeof bot.botName === "string" ? bot.botName : undefined,
      description: typeof bot.description === "string" ? bot.description : undefined,
      photoUrl: typeof bot.photoUrl === "string" ? bot.photoUrl : undefined,
    };
  });
}

export function projectBot(payload: unknown): unknown {
  const root = asRecord(payload) ?? {};
  return {
    botId: typeof root.botId === "number" ? root.botId : undefined,
    botName: typeof root.botName === "string" ? root.botName : undefined,
    description: typeof root.description === "string" ? root.description : undefined,
    photoUrl: typeof root.photoUrl === "string" ? root.photoUrl : undefined,
    enableCallback: typeof root.enableCallback === "boolean" ? root.enableCallback : undefined,
    enableGroupJoin: typeof root.enableGroupJoin === "boolean" ? root.enableGroupJoin : undefined,
    createdTime: typeof root.createdTime === "string" ? root.createdTime : undefined,
    modifiedTime: typeof root.modifiedTime === "string" ? root.modifiedTime : undefined,
  };
}

export function projectOrgUnits(payload: unknown): unknown {
  return projectList(payload, "orgUnits", (value) => {
    const unit = asRecord(value) ?? {};
    return {
      domainId: typeof unit.domainId === "number" ? unit.domainId : undefined,
      orgUnitId: typeof unit.orgUnitId === "string" ? unit.orgUnitId : undefined,
      orgUnitName: typeof unit.orgUnitName === "string" ? unit.orgUnitName : undefined,
      description: typeof unit.description === "string" ? unit.description : undefined,
      parentOrgUnitId: typeof unit.parentOrgUnitId === "string" ? unit.parentOrgUnitId : undefined,
      displayLevel: typeof unit.displayLevel === "number" ? unit.displayLevel : undefined,
      useNote: typeof unit.useNote === "boolean" ? unit.useNote : undefined,
      useCalendar: typeof unit.useCalendar === "boolean" ? unit.useCalendar : undefined,
      useTask: typeof unit.useTask === "boolean" ? unit.useTask : undefined,
      useFolder: typeof unit.useFolder === "boolean" ? unit.useFolder : undefined,
    };
  });
}

export function projectFormResponses(payload: unknown, options: { includeAnswers?: boolean; includeRespondent?: boolean } = {}): unknown {
  const includeAnswers = options.includeAnswers === true;
  const includeRespondent = options.includeRespondent === true;
  return projectList(payload, "responses", (value) => {
    const response = asRecord(value) ?? {};
    const respondent = asRecord(response.respondent);
    const questions = Array.isArray(response.questions) ? response.questions : [];
    return {
      formId: typeof response.formId === "string" ? response.formId : undefined,
      responseId: typeof response.responseId === "string" ? response.responseId : undefined,
      respondedTime: typeof response.respondedTime === "string" ? response.respondedTime : undefined,
      ...(includeRespondent && respondent ? { respondent: {
        id: typeof respondent.id === "string" ? respondent.id : undefined,
        name: typeof respondent.name === "string" ? respondent.name : undefined,
        email: maskEmail(respondent.email),
        organizationName: typeof respondent.organizationName === "string" ? respondent.organizationName : undefined,
        orgUnitName: typeof respondent.orgUnitName === "string" ? respondent.orgUnitName : undefined,
      } } : {}),
      questions: questions.slice(0, 200).flatMap((item) => {
        const question = asRecord(item);
        return question ? [{
          questionId: typeof question.questionId === "string" ? question.questionId : undefined,
          questionType: typeof question.questionType === "string" ? question.questionType : undefined,
          title: typeof question.title === "string" ? question.title : undefined,
          description: typeof question.description === "string" ? question.description : undefined,
          required: typeof question.required === "boolean" ? question.required : undefined,
          ...(includeAnswers ? { answers: Array.isArray(question.answers) ? question.answers.filter((answer): answer is string => typeof answer === "string").slice(0, 100) : [] } : {}),
        }] : [];
      }),
    };
  });
}

const MOCK = {
  calendar: { calendarId: "mock-calendar", calendarName: "기본 캘린더", isPublic: false, type: "INDIVIDUAL", members: [] },
  personals: { calendarPersonals: [{ calendarId: "mock-calendar", calendarName: "기본 캘린더", isShowOnLNBList: true, displayOrder: 0 }], responseMetaData: { nextCursor: "" } },
  events: { events: [{ eventComponents: [{ eventId: "mock-event", summary: "MCP mock 일정", start: { dateTime: "2026-08-03T09:00:00+09:00", timeZone: "Asia/Seoul" }, end: { dateTime: "2026-08-03T10:00:00+09:00", timeZone: "Asia/Seoul" }, location: "온라인" }] }], responseMetaData: { nextCursor: "" } },
  users: { users: [{ userId: "mock-user", email: "user@example.com", userName: { lastName: "MCP", firstName: "사용자" }, organizations: [] }], responseMetaData: { nextCursor: "" } },
  contacts: { contacts: [{ contactId: "mock-contact", permission: { accessibleRange: "ALL" }, contactName: { lastName: "Mock", firstName: "Contact", nickName: "MCP" }, emails: [{ primary: true, email: "contact@example.com" }], telephones: [{ primary: true, telephone: "010-0000-0000", type: "CELLPHONE" }], organizations: [{ primary: true, name: "MCP Example", department: "Engineering", title: "User" }], customProperties: { internal: "do-not-return" } }], responseMetaData: { nextCursor: "" } },
  contact: { contactId: "mock-contact", permission: { accessibleRange: "ALL" }, contactName: { lastName: "Mock", firstName: "Contact", nickName: "MCP" }, emails: [{ primary: true, email: "contact@example.com" }], telephones: [{ primary: true, telephone: "010-0000-0000", type: "CELLPHONE" }], organizations: [{ primary: true, name: "MCP Example", department: "Engineering", title: "User" }], customProperties: { internal: "do-not-return" } },
  boards: { boards: [{ boardId: 100, boardName: "공지사항", description: "Mock 공지 게시판", createdTime: "2026-08-01T00:00:00+09:00", modifiedTime: "2026-08-03T00:00:00+09:00", displayOrder: 1 }], responseMetaData: { nextCursor: "" } },
  boardPosts: { posts: [{ boardId: 100, postId: 1, title: "MCP mock 공지", readCount: 0, commentCount: 0, fileCount: 0, createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", isMustRead: true, isUnread: true, userName: "MCP" }], responseMetaData: { nextCursor: "" } },
  boardPost: { boardId: 100, postId: 1, title: "MCP mock 공지", body: "모의 공지 본문입니다.", readCount: 0, commentCount: 0, fileCount: 0, createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", isMustRead: true, isUnread: true, userName: "MCP" },
  groups: { groups: [{ domainId: 1, groupId: "mock-group", groupName: "MCP 모의 그룹", description: "읽기 테스트 그룹", visible: true, useMessage: true, useNote: true, useCalendar: true, useTask: true, useFolder: true }], responseMetaData: { nextCursor: "" } },
  groupMembers: { members: [{ id: "mock-user", type: "USER" }], responseMetaData: { nextCursor: "" } },
  notePosts: { posts: [{ postId: 1, title: "MCP mock 그룹 공지", enableCollaboration: false, readCount: 0, commentCount: 0, fileCount: 0, likeCount: 0, createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", userId: "mock-user", userName: "MCP", isNotice: true }], responseMetaData: { nextCursor: "" } },
  notePost: { postId: 1, title: "MCP mock 그룹 공지", body: "모의 그룹 노트 공지 본문입니다.", enableCollaboration: false, readCount: 0, commentCount: 0, fileCount: 0, likeCount: 0, createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", userId: "mock-user", userName: "MCP", isNotice: true },
  tasks: { tasks: [{ taskId: "mock-task", title: "MCP mock 할 일", content: "모의 할 일 내용", dueDate: "2026-08-10", status: "TODO", createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", assignorName: "MCP", completionCondition: "ANY_ONE", assignees: [{ assigneeId: "mock-user", assigneeName: "사용자", status: "TODO" }] }], responseMetaData: { nextCursor: "" } },
  task: { taskId: "mock-task", title: "MCP mock 할 일", content: "모의 할 일 내용", dueDate: "2026-08-10", status: "TODO", createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00", assignorName: "MCP", completionCondition: "ANY_ONE", assignees: [{ assigneeId: "mock-user", assigneeName: "사용자", status: "TODO" }] },
  taskCategories: { taskCategories: [{ categoryId: "default", categoryName: "기본" }] },
  bots: { bots: [{ botId: 2000001, botName: "MCP mock Bot", description: "모의 Bot", photoUrl: "https://example.com/mock.png" }], responseMetaData: { nextCursor: "" } },
  bot: { botId: 2000001, botName: "MCP mock Bot", description: "모의 Bot", photoUrl: "https://example.com/mock.png", enableCallback: false, enableGroupJoin: false, createdTime: "2026-08-03T09:00:00+09:00", modifiedTime: "2026-08-03T09:00:00+09:00" },
  orgUnits: { orgUnits: [{ domainId: 1, orgUnitId: "mock-orgunit", orgUnitName: "MCP 조직", description: "모의 조직", displayLevel: 1, useNote: true, useCalendar: true, useTask: true, useFolder: true }], responseMetaData: { nextCursor: "" } },
  formResponses: { responses: [{ formId: "mock-form", responseId: "mock-response", respondedTime: "2026-08-03T09:00:00+09:00", respondent: { id: "mock-user", name: "사용자", email: "user@example.com", organizationName: "예시회사", orgUnitName: "기획" }, questions: [{ questionId: "q1", questionType: "TEXT", title: "질문", description: "", required: true, answers: ["모의 응답"] }] }], responseMetaData: { nextCursor: "" } },
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
    if (normalizedPath.includes("\\") || /%(2e|2f|5c)/i.test(normalizedPath) || normalizedPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new WorksApiError("NAVER WORKS API path에 인코딩·상대 경로·역슬래시를 사용할 수 없습니다.");
    }
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
    if (path === "/boards" || /^\/boards\/[^/]+$/.test(path)) return { data: (path === "/boards" ? MOCK.boards : MOCK.boards.boards[0]) as T, status: 200 };
    if (path === "/boards/recent/posts" || path === "/boards/my/posts" || path === "/boards/must/posts" || /^\/boards\/[^/]+\/posts$/.test(path)) return { data: MOCK.boardPosts as T, status: 200 };
    if (/^\/boards\/[^/]+\/posts\/[^/]+$/.test(path)) return { data: MOCK.boardPost as T, status: 200 };
    if (path === "/groups") return { data: MOCK.groups as T, status: 200 };
    if (/^\/groups\/[^/]+$/.test(path)) return { data: MOCK.groups.groups[0] as T, status: 200 };
    if (/^\/groups\/[^/]+\/members$/.test(path)) return { data: MOCK.groupMembers as T, status: 200 };
    if (/^\/groups\/[^/]+\/note\/posts$/.test(path) || /^\/groups\/[^/]+\/note\/posts\/search$/.test(path)) return { data: MOCK.notePosts as T, status: 200 };
    if (/^\/groups\/[^/]+\/note\/posts\/[^/]+$/.test(path)) return { data: MOCK.notePost as T, status: 200 };
    if (path === "/tasks" || /^\/tasks\/[^/]+$/.test(path)) return { data: { task: MOCK.task } as T, status: 200 };
    if (/^\/users\/[^/]+\/tasks$/.test(path)) return { data: MOCK.tasks as T, status: 200 };
    if (/^\/users\/[^/]+\/task-categories$/.test(path) || /^\/users\/[^/]+\/task-categories\/[^/]+$/.test(path)) return { data: MOCK.taskCategories as T, status: 200 };
    if (path === "/bots") return { data: MOCK.bots as T, status: 200 };
    if (/^\/bots\/[^/]+$/.test(path)) return { data: MOCK.bot as T, status: 200 };
    if (path === "/orgunits") return { data: MOCK.orgUnits as T, status: 200 };
    if (/^\/forms\/[^/]+\/responses$/.test(path)) return { data: MOCK.formResponses as T, status: 200 };
    if (path === "/contacts") return { data: MOCK.contacts as T, status: 200 };
    if (/^\/contacts\/[^/]+$/.test(path)) return { data: MOCK.contact as T, status: 200 };
    if (path.endsWith("/calendar")) return { data: MOCK.calendar as T, status: 200 };
    if (path.endsWith("/calendar-personals")) return { data: MOCK.personals as T, status: 200 };
    if (path.includes("/calendar/events") || path.includes("/calendars/")) return { data: MOCK.events as T, status: 200 };
    if (path === "/users") return { data: MOCK.users as T, status: 200 };
    if (/^\/users\/[^/]+\/contacts$/.test(path)) return { data: MOCK.contacts as T, status: 200 };
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
