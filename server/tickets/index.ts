import type { Express, Request } from "express";
import { z } from "zod";
import type {
  AiService,
  Category,
  CoverageRow,
  EventAction,
  EventInput,
  Location,
  Receipt,
  ReceiptCoverageResult,
  ReceiptDraft,
  ReceiptDraftInput,
  ReceiptSegment,
  ResponseItem,
  Site,
  SubmitTicket,
  Ticket,
  TicketEvent,
  TicketStatus,
} from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/index.js";
import type { Auth, Resident, Staff } from "../auth/index.js";
import type { Drafts, StoredDraft } from "../drafts/index.js";
import type { Tasks, Job } from "../tasks/index.js";
import type {
  Uploads,
  Attachment as StoredAttachment,
} from "../uploads/index.js";
import { detectEmergency } from "../ai/emergency.js";
import { fail, hash, id, now, rateLimit, version } from "../http/index.js";

interface StoredReceiptDraft extends ReceiptDraft {
  assigneeId: string;
  ticketVersion: number;
  scopeHash: string;
  textHash: string;
}
export interface StoredTicket extends Ticket {
  needsReview: boolean;
  stopReason: string | null;
  inputVersion: number;
  ownerId: string;
  draftId: string;
  attachmentIds: string[];
  effectiveFactIds: string[];
  receiptDraft: StoredReceiptDraft | null;
}
interface StoredEvent extends TicketEvent {
  actorId: string;
  actorType: "resident" | "staff";
  receiptId?: string;
  receiptVersion?: number;
  scopeVersion?: number;
}
const action = z.enum([
  "claim",
  "progress",
  "request_info",
  "reply_info",
  "receipt",
  "confirm",
  "reopen",
  "withdraw",
  "return",
]);
const eventSchema = z.object({
  action,
  version: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(150),
  reason: z.string().trim().max(500).optional(),
  feedbackKind: z.enum(["items", "other", "not_sure"]).optional(),
  itemIds: z.array(z.string().min(1).max(100)).max(3).optional(),
  receiptId: z.string().uuid().optional(),
  receiptVersion: z.number().int().positive().optional(),
  scopeVersion: z.number().int().nonnegative().optional(),
  draftVersion: z.number().int().positive().optional(),
});
const scopeSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      text: z.string().trim().min(1).max(60),
      sourceRefs: z
        .array(
          z.object({
            source: z.enum(["submission", "supplement"]),
            sourceId: z.string().min(1).max(100),
            quote: z.string().trim().min(1).max(500),
          }),
        )
        .min(1)
        .max(5),
    }),
  )
  .max(3);
const receiptSchema = z.object({
  version: z.number().int().positive(),
  draftVersion: z.number().int().nonnegative().optional(),
  scopeVersion: z.number().int().nonnegative().optional(),
  items: scopeSchema,
  description: z.string().trim().min(1).max(500),
  attachmentIds: z.array(z.string().uuid()).min(1).max(3),
});
const submitSchema = z.object({
  draftId: z.string().uuid(),
  version: z.number().int().positive(),
  category: z.enum(["lighting", "facility", "cleaning", "unknown"]),
  locationId: z.string().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  confirmed: z.literal(true),
  idempotencyKey: z.string().min(8).max(150),
});
const residentActions = new Set<EventAction>([
  "reply_info",
  "confirm",
  "reopen",
  "withdraw",
]);
export class Tickets {
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    readonly drafts: Drafts,
    readonly tasks: Tasks,
    readonly uploads: Uploads,
    readonly ai: AiService,
    readonly config: AppConfig,
    readonly sites: Site[],
    readonly locations: Location[],
  ) {}
  raw(ticketId: string): StoredTicket {
    return (
      this.store.get<StoredTicket>("ticket", ticketId) ||
      fail(404, "NOT_FOUND", "没有找到此工单。")
    );
  }
  access(
    req: Request,
    ticketId: string,
  ): { ticket: StoredTicket; resident?: Resident; staff?: Staff } {
    const resident = this.auth.read<Resident>(req, "resident"),
      staff = this.auth.read<Staff>(req, "staff");
    if (!resident && !staff)
      fail(401, "SESSION_REQUIRED", "请先恢复浏览器会话或登录。");
    const ticket = this.raw(ticketId);
    if (resident?.id === ticket.ownerId && resident.siteId === ticket.siteId)
      return {
        ticket,
        resident,
        staff: staff?.siteId === ticket.siteId ? staff : undefined,
      };
    if (staff?.siteId === ticket.siteId) return { ticket, staff };
    fail(403, "FORBIDDEN", "无权访问此工单。");
  }
  assertWritable(ticket: StoredTicket): void {
    if (ticket.isExample)
      fail(
        409,
        "EXAMPLE_READ_ONLY",
        "演示样例为只读记录，请新建报修体验实际处理流程。",
      );
  }
  currentStaff(req: Request, ticket: StoredTicket, assigned = false): Staff {
    const staff = this.auth.staff(req);
    if (staff.siteId !== ticket.siteId)
      fail(403, "FORBIDDEN", "没有此场地权限。");
    this.assertWritable(ticket);
    if (assigned && ticket.assigneeId !== staff.id)
      fail(403, "NOT_ASSIGNEE", "仅当前负责人可以执行此操作。");
    return staff;
  }
  view(ticket: StoredTicket, staff = false): Ticket {
    const { ownerId, draftId, attachmentIds, effectiveFactIds, ...visible } =
      ticket;
    const events = this.store
      .events<StoredEvent>(ticket.id)
      .map(({ actorId, actorType, ...event }) => event);
    let receiptDraft: ReceiptDraft | null = null;
    if (
      staff &&
      ticket.receiptDraft &&
      ticket.status === "processing" &&
      ticket.receiptDraft.ticketVersion === ticket.version &&
      ticket.receiptDraft.assigneeId === ticket.assigneeId
    ) {
      const { assigneeId, ticketVersion, scopeHash, textHash, ...draft } =
        ticket.receiptDraft;
      receiptDraft = {
        ...draft,
        segments: this.segments(draft.description),
        attachments: draft.attachmentIds.map((a) => this.drafts.attachment(a)),
      };
    }
    return {
      ...visible,
      events,
      attachments: attachmentIds.map((a) => this.drafts.attachment(a)),
      receiptDraft,
    };
  }
  assertState(ticket: StoredTicket, allowed: TicketStatus[]) {
    if (!allowed.includes(ticket.status))
      fail(409, "INVALID_STATE", "当前状态不允许此操作，请刷新后核对。", {
        status: ticket.status,
      });
  }
  validateScope(ticket: StoredTicket, items: ResponseItem[]) {
    if (this.config.responseItemsEnabled && items.length < 1)
      fail(422, "ITEMS_REQUIRED", "请从原报说明确认至少一条需要回应的事项。");
    if (new Set(items.map((i) => i.id)).size !== items.length)
      fail(422, "DUPLICATE_ITEMS", "事项编号不能重复。");
    const events = this.store.events<StoredEvent>(ticket.id);
    for (const item of items)
      for (const ref of item.sourceRefs) {
        if (ref.source === "submission") {
          if (
            ref.sourceId !== ticket.submissionId ||
            !ticket.description.includes(ref.quote)
          )
            fail(
              422,
              "INVALID_SOURCE_REF",
              "事项必须引用本单最终说明的原文片段。",
            );
        } else {
          const event = events.find(
            (e) =>
              e.id === ref.sourceId &&
              e.action === "reply_info" &&
              e.actorType === "resident",
          );
          if (!event || !event.reason.includes(ref.quote))
            fail(
              422,
              "INVALID_SOURCE_REF",
              "事项只能引用本单居民补充的原文片段。",
            );
        }
      }
  }
  segments(text: string): ReceiptSegment[] {
    return (text.match(/[^。！？!?\n]+[。！？!?]?/gu) || [text])
      .map((part, i) => ({ id: `s${i + 1}`, text: part.trim() }))
      .filter((s) => !!s.text);
  }
  validateCoverage(
    result: ReceiptCoverageResult,
    items: ResponseItem[],
    segments: ReceiptSegment[],
  ) {
    const rows = z
      .object({
        rows: z
          .array(
            z.object({
              itemId: z.string(),
              status: z.enum(["response_found", "response_missing", "unclear"]),
              receiptTextRefs: z.array(z.string()).max(20),
              explanation: z.string().max(80),
            }),
          )
          .max(3),
      })
      .parse(result).rows;
    if (
      rows.length !== items.length ||
      new Set(rows.map((r) => r.itemId)).size !== rows.length ||
      !rows.every((r) => items.some((i) => i.id === r.itemId))
    )
      fail(422, "INVALID_CHECK_MAPPING", "核对结果没有逐项对应当前事项。");
    for (const row of rows) {
      if (
        (row.status === "response_found" && row.receiptTextRefs.length === 0) ||
        (row.status === "response_missing" &&
          row.receiptTextRefs.length !== 0) ||
        new Set(row.receiptTextRefs).size !== row.receiptTextRefs.length ||
        row.receiptTextRefs.some((ref) => !segments.some((s) => s.id === ref))
      )
        fail(422, "INVALID_CHECK_REF", "核对结果引用了无效回执原句。");
    }
  }
  activeDraft(ticket: StoredTicket, staff: Staff): StoredReceiptDraft {
    const draft =
      ticket.receiptDraft ||
      fail(409, "RECEIPT_DRAFT_REQUIRED", "请先保存本次回执草稿。");
    if (draft.assigneeId !== staff.id || draft.ticketVersion !== ticket.version)
      fail(
        409,
        "RECEIPT_DRAFT_STALE",
        "工单或负责人已更新，请重新确认本次事项和回执。",
      );
    return draft;
  }
  saveReceipt(req: Request, input: ReceiptDraftInput): ReceiptDraft {
    const ticket = this.raw(String(req.params.id)),
      staff = this.currentStaff(req, ticket, true);
    this.assertState(ticket, ["processing"]);
    version(ticket.version, input.version);
    this.validateScope(ticket, input.items);
    this.uploads.refs(input.attachmentIds, { ticketId: ticket.id }, "receipt");
    for (const aid of input.attachmentIds) {
      const photo = this.store.get<StoredAttachment & { receiptId?: string }>(
        "attachment",
        aid,
      )!;
      if (photo.receiptId)
        fail(422, "PHOTO_ALREADY_PUBLISHED", "请选择本次处理的现场照片。");
    }
    let previous = ticket.receiptDraft;
    if (
      previous &&
      (previous.assigneeId !== staff.id ||
        previous.ticketVersion !== ticket.version)
    )
      previous = null;
    version(previous?.version || 0, input.draftVersion || 0);
    version(previous?.scopeVersion || 0, input.scopeVersion || 0);
    const scopeHash = hash(input.items),
      scopeVersion = previous
        ? previous.scopeVersion + (previous.scopeHash === scopeHash ? 0 : 1)
        : 1;
    const draft: StoredReceiptDraft = {
      id: previous?.id || id(),
      ticketId: ticket.id,
      version: (previous?.version || 0) + 1,
      scopeVersion,
      items: structuredClone(input.items),
      description: input.description,
      attachmentIds: [...input.attachmentIds],
      attachments: [],
      check: null,
      checkTaskId: null,
      assigneeId: staff.id,
      ticketVersion: ticket.version,
      scopeHash,
      textHash: hash(input.description),
    };
    if (ticket.receiptDraft)
      this.store.put("receipt_draft_history", {
        ...ticket.receiptDraft,
        id: `${ticket.receiptDraft.id}:${ticket.receiptDraft.version}`,
      });
    ticket.receiptDraft = draft;
    this.store.put("ticket", ticket);
    return this.view(ticket, true).receiptDraft!;
  }
  feedback(
    ticket: StoredTicket,
    input: EventInput,
  ): {
    kind: "items" | "other" | "not_sure";
    itemIds: string[];
    itemTexts: string[];
    reason: string;
  } {
    const receipt =
      ticket.currentReceipt ||
      fail(409, "RECEIPT_REQUIRED", "当前没有可反馈的已发布回执。");
    if (
      input.receiptId !== receipt.id ||
      input.receiptVersion !== receipt.version
    )
      fail(409, "RECEIPT_CHANGED", "当前回执已更新，请保留输入并重新核对。");
    if (
      ticket.status === "closed" &&
      (!ticket.closedAt ||
        Date.now() - Date.parse(ticket.closedAt) > 7 * 86400000)
    )
      fail(409, "REOPEN_EXPIRED", "关闭已超过 7 天，请按新问题报修。");
    const hasScope =
      this.config.responseItemsEnabled && receipt.items.length > 0;
    if (hasScope) {
      if (input.scopeVersion !== receipt.scopeVersion)
        fail(409, "SCOPE_CHANGED", "回应事项已更新，请保留输入并重新核对。");
      if (!input.feedbackKind)
        fail(
          422,
          "FEEDBACK_KIND_REQUIRED",
          "请选择未解决事项、其他问题或暂时无法确认。",
        );
      const ids = input.itemIds || [];
      if (input.feedbackKind === "items") {
        if (
          ids.length === 0 ||
          new Set(ids).size !== ids.length ||
          ids.some((i) => !receipt.items.some((v) => v.id === i))
        )
          fail(
            422,
            "INVALID_FEEDBACK_ITEMS",
            "请选择当前回执中的至少一条事项。",
          );
        if ((input.reason || "").length > 300)
          fail(422, "REASON_LIMIT", "补充说明不能超过 300 字。");
        const itemTexts = ids.map(
          (i) => receipt.items.find((v) => v.id === i)!.text,
        );
        return {
          kind: "items",
          itemIds: ids,
          itemTexts,
          reason: input.reason || itemTexts.join("；"),
        };
      }
      if (ids.length)
        fail(
          422,
          "EXCLUSIVE_FEEDBACK",
          "其他问题或暂时无法确认不能与事项同时选择。",
        );
      if (!input.reason?.trim() || input.reason.length > 300)
        fail(422, "REASON_REQUIRED", "请补充 1 至 300 字说明。");
      return {
        kind: input.feedbackKind,
        itemIds: [],
        itemTexts: [],
        reason: input.reason,
      };
    }
    if (!input.reason?.trim() || input.reason.length > 300)
      fail(422, "REASON_REQUIRED", "请说明仍未解决的原因（1 至 300 字）。");
    if (input.itemIds?.length)
      fail(
        422,
        "INVALID_FEEDBACK_ITEMS",
        "当前回执没有可选择的事项，请填写原因。",
      );
    return { kind: "other", itemIds: [], itemTexts: [], reason: input.reason };
  }
  event(req: Request, input: EventInput) {
    // Authorization precedes idempotency lookup; replay precedes state/version checks.
    const access = this.access(req, String(req.params.id)),
      ticket = access.ticket;
    const actorType = residentActions.has(input.action) ? "resident" : "staff";
    const actor =
      actorType === "resident" ? this.auth.resident(req) : this.auth.staff(req);
    if (
      actorType === "resident" &&
      (actor.id !== ticket.ownerId || actor.siteId !== ticket.siteId)
    )
      fail(403, "FORBIDDEN", "只有原浏览器居民会话可以执行此操作。");
    if (actorType === "staff" && actor.siteId !== ticket.siteId)
      fail(403, "FORBIDDEN", "没有此场地权限。");
    this.assertWritable(ticket);
    const scope = `event:${ticket.id}:${actorType}:${actor.id}`,
      inputHash = hash(input),
      replay = this.store.replay<{ ticket: Ticket; event: TicketEvent }>(
        scope,
        input.idempotencyKey,
      );
    if (replay) {
      if (replay.hash !== inputHash)
        fail(409, "IDEMPOTENCY_CONFLICT", "相同操作编号不能提交不同内容。");
      return replay.data;
    }
    version(ticket.version, input.version);
    const previousDraft = ticket.receiptDraft;
    const before = ticket.status;
    let reason = input.reason || "",
      receipt: Receipt | undefined,
      feedback: TicketEvent["feedback"];
    const requireReason = () => {
      if (!reason.trim()) fail(422, "REASON_REQUIRED", "请填写具体说明。");
    };
    switch (input.action) {
      case "claim":
        this.assertState(ticket, ["pending"]);
        if (ticket.assigneeId)
          fail(409, "ALREADY_ASSIGNED", "工单已经被认领。");
        ticket.assigneeId = actor.id;
        ticket.assigneeName = (actor as Staff).name;
        ticket.status = "processing";
        break;
      case "progress":
        this.assertState(ticket, ["processing"]);
        this.currentStaff(req, ticket, true);
        requireReason();
        break;
      case "request_info":
        this.assertState(ticket, ["pending", "processing"]);
        if (ticket.status === "processing")
          this.currentStaff(req, ticket, true);
        requireReason();
        ticket.returnStatus = ticket.status;
        ticket.status = "needs_info";
        break;
      case "reply_info":
        this.assertState(ticket, ["needs_info"]);
        requireReason();
        this.drafts.emergency(reason);
        ticket.status =
          ticket.returnStatus === "processing" ? "processing" : "pending";
        ticket.returnStatus = null;
        ticket.receiptDraft = null;
        break;
      case "return":
        this.assertState(ticket, ["processing", "needs_info"]);
        this.currentStaff(req, ticket, true);
        if (
          ticket.status === "needs_info" &&
          ticket.returnStatus !== "processing"
        )
          fail(409, "INVALID_STATE", "此工单当前没有负责人可退回。");
        requireReason();
        ticket.status = "pending";
        ticket.assigneeId = null;
        ticket.assigneeName = null;
        ticket.returnStatus = null;
        ticket.receiptDraft = null;
        break;
      case "withdraw":
        this.assertState(ticket, ["pending"]);
        ticket.status = "withdrawn";
        break;
      case "receipt": {
        this.assertState(ticket, ["processing"]);
        const staff = this.currentStaff(req, ticket, true),
          draft = this.activeDraft(ticket, staff);
        version(draft.version, input.draftVersion || 0);
        version(draft.scopeVersion, input.scopeVersion || 0);
        this.validateScope(ticket, draft.items);
        this.uploads.refs(
          draft.attachmentIds,
          { ticketId: ticket.id },
          "receipt",
        );
        if (
          draft.attachmentIds.length < 1 ||
          draft.attachmentIds.length > 3 ||
          !draft.description.trim()
        )
          fail(
            422,
            "RECEIPT_INCOMPLETE",
            "处理回执需要说明和 1 至 3 张现场照片。",
          );
        const segments = this.segments(draft.description);
        if (draft.check)
          this.validateCoverage(draft.check, draft.items, segments);
        receipt = {
          id: id(),
          version:
            this.store
              .events<StoredEvent>(ticket.id)
              .filter((e) => e.action === "receipt").length + 1,
          scopeVersion: draft.scopeVersion,
          items: structuredClone(draft.items),
          description: draft.description,
          attachments: draft.attachmentIds.map((a) =>
            this.drafts.attachment(a),
          ),
          coverage: draft.check ? structuredClone(draft.check) : null,
          segments,
          createdAt: now(),
        };
        for (const aid of draft.attachmentIds) {
          const photo = this.store.get<
            StoredAttachment & { receiptId?: string }
          >("attachment", aid)!;
          if (photo.receiptId)
            fail(422, "PHOTO_ALREADY_PUBLISHED", "现场照片已被其他回执使用。");
          this.store.put("attachment", { ...photo, receiptId: receipt.id });
        }
        ticket.currentReceipt = receipt;
        ticket.status = "awaiting_confirmation";
        ticket.receiptDraft = null;
        reason = receipt.description;
        break;
      }
      case "confirm":
        this.assertState(ticket, ["awaiting_confirmation"]);
        if (
          input.receiptId !== ticket.currentReceipt?.id ||
          input.receiptVersion !== ticket.currentReceipt?.version
        )
          fail(409, "RECEIPT_CHANGED", "请核对当前已发布回执后确认。");
        ticket.status = "closed";
        ticket.closedAt = now();
        break;
      case "reopen": {
        this.assertState(ticket, ["awaiting_confirmation", "closed"]);
        const value = this.feedback(ticket, input);
        this.drafts.emergency(value.reason);
        reason = value.reason;
        feedback = {
          kind: value.kind,
          itemIds: value.itemIds,
          itemTexts: value.itemTexts,
        };
        ticket.status = "pending";
        ticket.assigneeId = null;
        ticket.assigneeName = null;
        ticket.closedAt = null;
        ticket.returnStatus = null;
        ticket.receiptDraft = null;
        break;
      }
    }
    if (previousDraft) {
      this.store.put("receipt_draft_history", {
        ...previousDraft,
        id: `${previousDraft.id}:${previousDraft.version}`,
      });
      ticket.receiptDraft = null;
    }
    ticket.version++;
    ticket.updatedAt = now();
    const event: StoredEvent = {
      id: id(),
      action: input.action,
      actorId: actor.id,
      actorType,
      actorName: actorType === "staff" ? (actor as Staff).name : "居民",
      createdAt: now(),
      reason,
      fromStatus: before,
      toStatus: ticket.status,
      ...(receipt ? { receipt } : {}),
      ...(feedback
        ? {
            feedback,
            receiptId: input.receiptId,
            receiptVersion: input.receiptVersion,
            scopeVersion: input.scopeVersion,
          }
        : {}),
    };
    this.store.put("ticket", ticket);
    this.store.audit(ticket.id, event);
    const data = {
      ticket: this.view(ticket, actorType === "staff"),
      event: (({ actorId, actorType, ...v }) => v)(event),
    };
    this.store.remember(scope, input.idempotencyKey, inputHash, data);
    return data;
  }
  routes(app: Express) {
    // Reject read-only samples before body validation or feature/model checks.
    app.use(
      ["/api/tickets/:id/events", "/api/tickets/:id/receipt-draft"],
      (req, _res, next) => {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
          this.assertWritable(this.access(req, String(req.params.id)).ticket);
        next();
      },
    );
    app.post("/api/tickets", rateLimit(40, 60000), (req, res) => {
      const input = submitSchema.parse(req.body),
        resident = this.auth.resident(req),
        scope = `submit:${resident.id}`,
        inputHash = hash(input);
      const replay = this.store.replay<{ ticket: Ticket; queryPath: string }>(
        scope,
        input.idempotencyKey,
      );
      if (replay) {
        if (replay.hash !== inputHash)
          fail(409, "IDEMPOTENCY_CONFLICT", "相同确认编号不能提交不同内容。");
        return res.json(replay.data);
      }
      const result = this.store.tx(() => {
        const recovered = this.store.replay<{
          ticket: Ticket;
          queryPath: string;
        }>(scope, input.idempotencyKey);
        if (recovered) {
          if (recovered.hash !== inputHash)
            fail(409, "IDEMPOTENCY_CONFLICT", "相同确认编号不能提交不同内容。");
          return recovered.data;
        }
        const draft = this.drafts.get(req, input.draftId);
        version(draft.version, input.version);
        if (draft.submittedTicketId)
          fail(409, "DRAFT_SUBMITTED", "这个草稿已经提交，请恢复原工单。", {
            ticketId: draft.submittedTicketId,
          });
        this.drafts.checkLocation(draft.siteId, input.locationId);
        this.drafts.emergency(input.description);
        if (!draft.description.trim() && !draft.attachmentIds.length)
          fail(422, "INPUT_REQUIRED", "至少提供有效文字或一张可读取的图片。");
        this.uploads.refs(draft.attachmentIds, { draftId: draft.id }, "intake");
        const site = this.sites.find((s) => s.id === draft.siteId)!,
          location = this.locations.find(
            (l) => l.id === input.locationId && l.siteId === draft.siteId,
          )!;
        const ticketId = id(),
          ticket: StoredTicket = {
            id: ticketId,
            number: `LL${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${id().slice(0, 6).toUpperCase()}`,
            siteId: draft.siteId,
            siteName: site.name,
            locationId: location.id,
            locationName: location.name,
            category: input.category,
            description: input.description,
            submissionId: id(),
            status: "pending",
            assigneeId: null,
            assigneeName: null,
            version: 1,
            createdAt: now(),
            updatedAt: now(),
            closedAt: null,
            returnStatus: null,
            facts:
              input.description === draft.description &&
              draft.analysisVersion === draft.version &&
              draft.analysisHash ===
                hash({
                  description: draft.description,
                  attachmentIds: draft.attachmentIds,
                })
                ? draft.analysis?.facts || []
                : [],
            attachments: [],
            events: [],
            currentReceipt: null,
            receiptDraft: null,
            needsReview:
              !!draft.stopReason ||
              draft.category === "unknown" ||
              !draft.analysis ||
              draft.analysis.needsReview,
            stopReason: draft.stopReason,
            inputVersion: draft.version,
            ownerId: resident.id,
            draftId: draft.id,
            attachmentIds: [...draft.attachmentIds],
            effectiveFactIds:
              input.description === draft.description &&
              draft.analysisVersion === draft.version &&
              draft.analysisHash ===
                hash({
                  description: draft.description,
                  attachmentIds: draft.attachmentIds,
                })
                ? draft.effectiveFactIds
                : [],
          };
        this.store.put("ticket", ticket);
        for (const aid of draft.attachmentIds) {
          const photo = this.store.get<StoredAttachment>("attachment", aid)!;
          this.store.put("attachment", {
            ...photo,
            ticketId: ticket.id,
            originatingDraftId: photo.originatingDraftId || draft.id,
            draftId: undefined,
          });
        }
        draft.submittedTicketId = ticket.id;
        this.store.put("draft", draft);
        this.store.audit(ticket.id, {
          id: id(),
          action: "created",
          actorId: resident.id,
          actorType: "resident",
          actorName: "居民",
          createdAt: now(),
          reason: "居民已核对并确认报修信息。",
          fromStatus: null,
          toStatus: "pending",
        } as StoredEvent);
        const data = {
          ticket: this.view(ticket),
          queryPath: `/tickets/${ticket.id}`,
        };
        this.store.remember(scope, input.idempotencyKey, inputHash, data);
        return data;
      });
      res.status(201).json(result);
    });
    app.get("/api/submissions/:key", (req, res) => {
      const resident = this.auth.resident(req),
        value = this.store.replay<{ ticket: Ticket; queryPath: string }>(
          `submit:${resident.id}`,
          String(req.params.key),
        );
      if (!value)
        fail(
          404,
          "SUBMISSION_NOT_FOUND",
          "此浏览器没有找到该提交结果，请使用原确认编号重试。",
        );
      res.json(value.data);
    });
    app.get("/api/me/tickets", (req, res) => {
      const resident = this.auth.resident(req);
      const tickets = this.store
        .all<StoredTicket>("ticket")
        .filter(
          (t) => t.ownerId === resident.id && t.siteId === resident.siteId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ tickets: tickets.map((t) => this.view(t)) });
    });
    app.get("/api/staff/tickets", (req, res) => {
      const staff = this.auth.staff(req);
      const filter = z
        .object({
          status: z
            .enum([
              "pending",
              "processing",
              "needs_info",
              "awaiting_confirmation",
              "closed",
              "withdrawn",
            ])
            .optional(),
          page: z.coerce.number().int().positive().default(1),
        })
        .parse(req.query);
      const tickets = this.store
        .all<StoredTicket>("ticket")
        .filter(
          (t) =>
            t.siteId === staff.siteId &&
            (!filter.status || t.status === filter.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({
        tickets: tickets
          .slice((filter.page - 1) * 30, filter.page * 30)
          .map((t) => this.view(t, true)),
        total: tickets.length,
        page: filter.page,
      });
    });
    app.get("/api/tickets/:id", (req, res) => {
      const { ticket, staff } = this.access(req, String(req.params.id));
      res.json(this.view(ticket, !!staff));
    });
    app.post("/api/tickets/:id/events", rateLimit(60, 60000), (req, res) => {
      const input = eventSchema.parse(req.body);
      res.json(this.store.tx(() => this.event(req, input)));
    });
    app.put("/api/tickets/:id/receipt-draft", (req, res) => {
      const input = receiptSchema.parse(req.body);
      res.json(this.store.tx(() => this.saveReceipt(req, input)));
    });
    app.post(
      "/api/tickets/:id/receipt-draft/check",
      rateLimit(12, 60000),
      (req, res) => {
        if (!this.config.receiptCheckEnabled)
          fail(
            409,
            "FEATURE_DISABLED",
            "回执 AI 核对已关闭，可以人工核对后发布。",
          );
        const input = z
          .object({
            version: z.number().int().positive(),
            draftVersion: z.number().int().positive(),
            scopeVersion: z.number().int().positive(),
          })
          .parse(req.body);
        const ticket = this.raw(String(req.params.id)),
          staff = this.currentStaff(req, ticket, true);
        this.assertState(ticket, ["processing"]);
        version(ticket.version, input.version);
        const draft = this.activeDraft(ticket, staff);
        version(draft.version, input.draftVersion);
        version(draft.scopeVersion, input.scopeVersion);
        this.validateScope(ticket, draft.items);
        const fingerprint = hash({
          purpose: "receipt_coverage",
          ticketId: ticket.id,
          assigneeId: staff.id,
          ticketVersion: ticket.version,
          draftId: draft.id,
          draftVersion: draft.version,
          scopeVersion: draft.scopeVersion,
          scopeHash: draft.scopeHash,
          textHash: draft.textHash,
          model: this.config.ai.model,
          rules: "receipt-v1.3",
        });
        const previous = this.tasks.find(fingerprint, true);
        if (previous) return res.status(202).json(this.tasks.view(previous));
        const count = this.store
          .all<Job>("task")
          .filter(
            (j) =>
              j.purpose === "receipt_coverage" &&
              j.ticketId === ticket.id &&
              Date.parse(j.createdAt) > Date.now() - 86400000,
          ).length;
        if (count >= 5)
          fail(
            429,
            "CHECK_DAILY_LIMIT",
            "本工单 24 小时内已使用 5 次核对，请人工核对后继续。",
          );
        const segments = this.segments(draft.description),
          supplementIds = new Set(
            draft.items.flatMap((i) =>
              i.sourceRefs
                .filter((r) => r.source === "supplement")
                .map((r) => r.sourceId),
            ),
          ),
          supplements = this.store
            .events<StoredEvent>(ticket.id)
            .filter(
              (e) =>
                e.action === "reply_info" &&
                e.actorType === "resident" &&
                supplementIds.has(e.id),
            )
            .map((e) => ({ id: e.id, text: e.reason }));
        const task = this.tasks.schedule(
          {
            purpose: "receipt_coverage",
            ownerId: staff.id,
            siteId: ticket.siteId,
            ticketId: ticket.id,
            inputVersion: ticket.version,
            fingerprint,
          },
          async () =>
            this.ai.checkReceipt({
              description: ticket.description,
              supplements,
              items: draft.items,
              segments,
            }),
          (value) => {
            const current = this.raw(ticket.id),
              currentDraft = current.receiptDraft;
            if (
              current.status !== "processing" ||
              current.assigneeId !== staff.id ||
              current.version !== ticket.version ||
              !currentDraft ||
              currentDraft.id !== draft.id ||
              currentDraft.version !== draft.version ||
              currentDraft.scopeVersion !== draft.scopeVersion
            )
              fail(
                409,
                "CHECK_STALE",
                "工单或回执草稿已更新，旧核对不再应用。",
              );
            this.validateCoverage(
              value as ReceiptCoverageResult,
              currentDraft.items,
              segments,
            );
            currentDraft.check = value as ReceiptCoverageResult;
            currentDraft.checkTaskId = task.id;
            this.store.put("ticket", current);
            return value;
          },
        );
        draft.checkTaskId = task.id;
        this.store.put("ticket", ticket);
        res.status(202).json(this.tasks.view(task));
      },
    );
  }
}
