import type {
  ExampleLoadResult,
  OperationsSummary,
  TicketFilters,
} from "../shared/operations";
import type {
  Attachment,
  Bootstrap,
  Draft,
  DraftPatch,
  EventInput,
  ReceiptDraft,
  ReceiptDraftInput,
  Staff,
  SubmitTicket,
  Task,
  Ticket,
} from "../shared/types";
import type {
  AuthResult,
  CreateStaffInput,
  LoginInput,
  PublicAccount,
  RegisterInput,
  AccountStatus,
} from "../shared/auth";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 25000,
  responseKind: "json" | "blob" = "json",
  expectedAccountId?: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers:
        body instanceof FormData
          ? undefined
          : {
              "Content-Type": "application/json",
              ...(expectedAccountId
                ? { "X-Account-Id": expectedAccountId }
                : {}),
            },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    if (response.ok && responseKind === "blob")
      return (await response.blob()) as T;
    // The deadline includes body consumption; receiving headers alone is not completion.
    const data = await response.json().catch((error: unknown) => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    if (!response.ok) {
      if (
        typeof window !== "undefined" &&
        ((response.status === 401 &&
          !/^\/api\/(?:auth\/|staff\/sessions|bootstrap|sessions\/anonymous)/.test(
            path,
          )) ||
          data?.error?.code === "ACCOUNT_CHANGED")
      )
        window.dispatchEvent(new Event("auth-expired"));
      throw new ApiError(
        response.status,
        data?.error?.code || "REQUEST_FAILED",
        data?.error?.message || "暂时无法完成操作，请稍后重试。",
      );
    }
    if (data === null)
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "服务返回的内容暂时无法读取，请稍后重试。",
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      0,
      "NETWORK",
      controller.signal.aborted
        ? "等待超时，你填写的内容仍在。可以重试或手动继续。"
        : "连接暂时中断，你填写的内容仍在。请检查网络后重试。",
    );
  } finally {
    clearTimeout(timeout);
  }
}
const ticketResult = async (result: Promise<Ticket | { ticket: Ticket }>) => {
  const value = await result;
  return "ticket" in value ? value.ticket : value;
};
const analyticsQuery = (filters: TicketFilters) =>
  new URLSearchParams(Object.entries(filters)).toString();
export const api = {
  analytics: (filters: TicketFilters) =>
    request<OperationsSummary>(
      `/api/staff/analytics?${analyticsQuery(filters)}`,
    ),
  exportAnalytics: (filters: TicketFilters) =>
    request<Blob>(
      `/api/staff/analytics/export?${analyticsQuery(filters)}`,
      "GET",
      undefined,
      25000,
      "blob",
    ),
  loadExamples: () =>
    request<ExampleLoadResult>("/api/staff/demo-examples", "POST", {
      confirmed: true,
    }),
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  anonymous: (siteId: string) =>
    request("/api/sessions/anonymous", "POST", { siteId }),
  login: (input: LoginInput) =>
    request<AuthResult>("/api/auth/login", "POST", input),
  register: (input: RegisterInput) =>
    request<AuthResult>("/api/auth/register", "POST", input),
  logout: () => request<void>("/api/auth/session", "DELETE"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/auth/password", "PATCH", {
      currentPassword,
      newPassword,
    }),
  users: () => request<{ users: PublicAccount[] }>("/api/admin/users"),
  createStaff: (input: CreateStaffInput) =>
    request<AuthResult>("/api/admin/users", "POST", input),
  setAccountStatus: (id: string, status: AccountStatus) =>
    request<AuthResult>(`/api/admin/users/${id}`, "PATCH", { status }),
  tickets: async (staff = false): Promise<{ tickets: Ticket[] }> => {
    if (!staff) return request<{ tickets: Ticket[] }>("/api/me/tickets");
    const first = await request<{ tickets: Ticket[]; total?: number }>(
      "/api/staff/tickets",
    );
    const tickets = [...first.tickets];
    for (let page = 2; first.total && tickets.length < first.total; page++) {
      const next = await request<{ tickets: Ticket[] }>(
        `/api/staff/tickets?page=${page}`,
      );
      if (!next.tickets.length) break;
      tickets.push(...next.tickets);
    }
    return { tickets };
  },
  ticket: (id: string) => request<Ticket>(`/api/tickets/${id}`),
  newDraft: (siteId: string, expectedAccountId: string) =>
    request<Draft>(
      "/api/drafts",
      "POST",
      { siteId },
      25000,
      "json",
      expectedAccountId,
    ),
  draft: (id: string) => request<Draft>(`/api/drafts/${id}`),
  saveDraft: (id: string, patch: DraftPatch) =>
    request<Draft>(`/api/drafts/${id}`, "PATCH", patch),
  analyze: (id: string, version: number) =>
    request<Task>(`/api/drafts/${id}/analyze`, "POST", {
      version,
      consent: true,
    }),
  task: (id: string, timeoutMs = 25000) =>
    request<Task>(`/api/tasks/${id}`, "GET", undefined, timeoutMs),
  submission: (idempotencyKey: string) =>
    request<{ ticket: Ticket; queryPath: string }>(
      `/api/submissions/${idempotencyKey}`,
    ),
  submit: (input: SubmitTicket) =>
    ticketResult(
      request<Ticket | { ticket: Ticket }>("/api/tickets", "POST", input),
    ),
  event: (id: string, input: EventInput) =>
    ticketResult(
      request<Ticket | { ticket: Ticket }>(
        `/api/tickets/${id}/events`,
        "POST",
        input,
      ),
    ),
  receipt: (id: string, input: ReceiptDraftInput) =>
    request<ReceiptDraft>(`/api/tickets/${id}/receipt-draft`, "PUT", input),
  check: (
    id: string,
    version: number,
    draftVersion: number,
    scopeVersion: number,
  ) =>
    request<Task>(`/api/tickets/${id}/receipt-draft/check`, "POST", {
      version,
      draftVersion,
      scopeVersion,
    }),
  upload: (file: File, target: { draftId: string } | { ticketId: string }) => {
    const data = new FormData();
    data.append("file", file);
    Object.entries(target).forEach(([key, value]) => data.append(key, value));
    data.append("purpose", "draftId" in target ? "draft" : "receipt");
    return request<Attachment>("/api/attachments", "POST", data);
  },
  removeAttachment: (id: string) =>
    request<void>(`/api/attachments/${id}`, "DELETE"),
};
export const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后重试。";
export async function pollTask(initial: Task): Promise<Task> {
  const deadline = Date.now() + 25000;
  let task = initial;
  while (task.state === "queued" || task.state === "running") {
    if (Date.now() >= deadline)
      throw new Error(
        "等待已超过 25 秒。内容已保留，可以手动继续；稍后刷新也可查看结果。",
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(750, deadline - Date.now())),
    );
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error("等待已超过 25 秒。内容已保留，可以手动继续。");
    task = await api.task(task.id, remaining);
  }
  if (task.state === "failed")
    throw new Error(
      task.error || "暂时无法自动整理，已保留你的内容，可以手动继续。",
    );
  return task;
}
export const key = () => crypto.randomUUID();
