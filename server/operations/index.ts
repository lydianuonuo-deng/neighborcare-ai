import type { Express, Request } from "express";
import { z } from "zod";
import {
  chinaDateKey,
  DEFAULT_TICKET_FILTERS,
  filterTickets,
  type OperationsSummary,
  type TicketFilters,
  type ExampleLoadResult,
} from "../../shared/operations.js";
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  type Category,
  type Location,
  type Receipt,
  type Site,
  type TicketEvent,
  type TicketStatus,
} from "../../shared/types.js";
import type { Auth } from "../auth/index.js";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/index.js";
import type { StoredTicket } from "../tickets/index.js";
import { fail, id } from "../http/index.js";

const statuses = Object.keys(STATUS_LABELS) as TicketStatus[];
const categories = Object.keys(CATEGORY_LABELS) as Category[];
const filterSchema = z.strictObject({
  query: z.string().max(200).default(DEFAULT_TICKET_FILTERS.query),
  status: z
    .enum([
      "all",
      "active",
      "attention",
      "ended",
      "pending",
      "processing",
      "needs_info",
      "awaiting_confirmation",
      "closed",
      "withdrawn",
    ])
    .default("all"),
  category: z
    .enum(["all", "lighting", "facility", "cleaning", "unknown"])
    .default("all"),
  locationId: z.string().max(100).default(""),
  assignee: z.enum(["all", "mine", "unassigned"]).default("all"),
  source: z.enum(["all", "manual", "example"]).default("all"),
  period: z.enum(["all", "7", "30"]).default("all"),
  sort: z.enum(["updated", "newest", "oldest"]).default("updated"),
});

/** Protect spreadsheet imports before applying the CSV quoting rules. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text.normalize("NFKC")))
    text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

interface ExampleBatch {
  id: string;
  siteId: "demo";
  ticketIds: string[];
  createdAt: string;
}

export class Operations {
  constructor(
    readonly store: Store,
    readonly auth: Auth,
    readonly config: AppConfig,
    readonly sites: Site[],
    readonly locations: Location[],
  ) {}

  summary(req: Request): OperationsSummary {
    const staff = this.auth.staff(req);
    const filters: TicketFilters = filterSchema.parse(req.query);
    const clock = Date.now();
    const tickets = filterTickets(
      this.store
        .all<StoredTicket>("ticket")
        .filter((ticket) => ticket.siteId === staff.siteId),
      filters,
      staff.id,
      clock,
    );
    const today =
      Math.floor((clock + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
    const daily = Array.from({ length: 14 }, (_, index) => ({
      date: chinaDateKey(today - (13 - index) * 86400000),
      count: 0,
    }));
    const byDay = new Map(daily.map((day) => [day.date, day]));
    for (const ticket of tickets) {
      if (!Number.isFinite(Date.parse(ticket.createdAt))) continue;
      const day = byDay.get(chinaDateKey(ticket.createdAt));
      if (day) day.count++;
    }
    return {
      generatedAt: new Date(clock).toISOString(),
      filters,
      totals: {
        total: tickets.length,
        active: tickets.filter(
          (t) => t.status !== "closed" && t.status !== "withdrawn",
        ).length,
        attention: tickets.filter(
          (t) =>
            t.status === "needs_info" || t.status === "awaiting_confirmation",
        ).length,
        closed: tickets.filter((t) => t.status === "closed").length,
        withdrawn: tickets.filter((t) => t.status === "withdrawn").length,
        examples: tickets.filter((t) => t.isExample === true).length,
      },
      byStatus: statuses.map((key) => ({
        key,
        label: STATUS_LABELS[key],
        count: tickets.filter((t) => t.status === key).length,
      })),
      byCategory: categories.map((key) => ({
        key,
        label: CATEGORY_LABELS[key],
        count: tickets.filter((t) => t.category === key).length,
      })),
      byLocation: this.locations
        .filter((location) => location.siteId === staff.siteId)
        .map((location) => ({
          key: location.id,
          label: location.name,
          count: tickets.filter((t) => t.locationId === location.id).length,
        })),
      daily,
    };
  }

  csv(summary: OperationsSummary): string {
    const { filters } = summary;
    const statusLabels = {
      all: "全部",
      active: "进行中",
      attention: "待居民回应",
      ended: "已结束",
      ...STATUS_LABELS,
    };
    // Free text can contain personal data; export only whether a keyword was set.
    const rows: (string | number)[][] = [
      ["分组", "项目", "数量或范围"],
      [
        "筛选",
        "关键词",
        filters.query.trim() ? "已设置（原文不导出）" : "未设置",
      ],
      ["筛选", "状态", statusLabels[filters.status]],
      [
        "筛选",
        "类别",
        filters.category === "all" ? "全部" : CATEGORY_LABELS[filters.category],
      ],
      [
        "筛选",
        "地点",
        filters.locationId
          ? summary.byLocation.find((row) => row.key === filters.locationId)
              ?.label || "指定地点（无匹配）"
          : "全部",
      ],
      [
        "筛选",
        "归属",
        { all: "全部", mine: "我的", unassigned: "未分配" }[filters.assignee],
      ],
      [
        "筛选",
        "来源",
        { all: "全部", manual: "手动提交", example: "只读样例" }[
          filters.source
        ],
      ],
      [
        "筛选",
        "提交时间",
        filters.period === "all" ? "全部" : `近${filters.period}天（北京时间）`,
      ],
      [
        "筛选",
        "排序",
        { updated: "最近更新", newest: "最新提交", oldest: "最早提交" }[
          filters.sort
        ],
      ],
      ["汇总", "总量", summary.totals.total],
      ["汇总", "进行中", summary.totals.active],
      ["汇总", "待居民回应", summary.totals.attention],
      ["汇总", "已关闭", summary.totals.closed],
      ["汇总", "已撤回", summary.totals.withdrawn],
      ["汇总", "只读样例", summary.totals.examples],
      ...summary.byStatus.map((row) => ["状态", row.label, row.count]),
      ...summary.byCategory.map((row) => ["类别", row.label, row.count]),
      ...summary.byLocation.map((row) => ["地点", row.label, row.count]),
      ...summary.daily.map((row) => [
        "日新增（北京时间）",
        row.date,
        row.count,
      ]),
    ];
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  loadExamples(req: Request): ExampleLoadResult {
    const staff = this.auth.staff(req);
    if (!this.config.demoMode || staff.siteId !== "demo")
      fail(403, "DEMO_ONLY", "只读演示样例仅可在演示空间载入。");
    z.strictObject({ confirmed: z.literal(true) }).parse(req.body);
    return this.store.tx(() => {
      const batchId = "linli-v03-demo-examples";
      const previous = this.store.get<ExampleBatch>("demo_fixture", batchId);
      if (previous)
        return {
          created: 0,
          existing: previous.ticketIds.filter((ticketId) => {
            const ticket = this.store.get<StoredTicket>("ticket", ticketId);
            return ticket?.siteId === "demo" && ticket.isExample === true;
          }).length,
        };
      const site =
        this.sites.find((site) => site.id === "demo") ||
        fail(403, "DEMO_ONLY", "演示空间未启用。");
      const locations = this.locations.filter(
        (location) => location.siteId === "demo",
      );
      if (locations.length !== 4)
        fail(409, "DEMO_LOCATIONS_REQUIRED", "请先配置演示空间的四个地点。");
      const clock = Date.now();
      const ticketIds: string[] = [];
      for (let index = 0; index < 12; index++) {
        const ticketId = id();
        ticketIds.push(ticketId);
        const status = statuses[Math.floor(index / 2)]!;
        const location = locations[index % locations.length]!;
        const createdAt = new Date(
          clock - Math.floor((index * 13) / 11) * 86400000,
        ).toISOString();
        const assigned = status !== "pending" && status !== "withdrawn";
        const currentReceipt: Receipt | null =
          status === "awaiting_confirmation" || status === "closed"
            ? {
                id: id(),
                version: 1,
                scopeVersion: 0,
                items: [],
                description:
                  "演示样例：这是一份只读合成回执，不代表真实处理或维修结果。",
                attachments: [],
                coverage: null,
                segments: [],
                createdAt,
              }
            : null;
        const ticket: StoredTicket = {
          id: ticketId,
          number: `演示样例-${String(index + 1).padStart(2, "0")}`,
          isExample: true,
          siteId: site.id,
          siteName: site.name,
          locationId: location.id,
          locationName: location.name,
          category: categories[index % categories.length]!,
          description: `演示样例：${location.name}的${CATEGORY_LABELS[categories[index % categories.length]!]}记录，仅用于查看${STATUS_LABELS[status]}阶段。非真实居民报修，不能执行处理操作。`,
          submissionId: id(),
          status,
          assigneeId: assigned ? "demo-staff-1" : null,
          assigneeName: assigned ? "林师傅（演示样例）" : null,
          version: 1,
          createdAt,
          updatedAt: createdAt,
          closedAt: status === "closed" ? createdAt : null,
          returnStatus: status === "needs_info" ? "processing" : null,
          facts: [],
          attachments: [],
          events: [],
          currentReceipt,
          receiptDraft: null,
          needsReview: false,
          stopReason: null,
          inputVersion: 1,
          ownerId: `synthetic-example-owner:${ticketId}`,
          draftId: `synthetic-example-draft:${ticketId}`,
          attachmentIds: [],
          effectiveFactIds: [],
        };
        this.store.put("ticket", ticket);
        const event: TicketEvent & { actorId: string; actorType: "staff" } = {
          id: id(),
          action: "created",
          actorId: "synthetic-example-loader",
          actorType: "staff",
          actorName: "演示样例生成器",
          createdAt,
          reason: "演示样例：合成的只读阶段快照，非真实居民提交或处理记录。",
          fromStatus: null,
          toStatus: currentReceipt ? "processing" : status,
        };
        this.store.audit(ticketId, event);
        if (currentReceipt) {
          const receiptEvent: typeof event = {
            ...event,
            id: id(),
            action: "receipt",
            fromStatus: "processing",
            toStatus: "awaiting_confirmation",
            receipt: currentReceipt,
            reason:
              "演示样例：合成的只读回执，没有现场照片、模型核对或真实发布行为。",
          };
          this.store.audit(ticketId, receiptEvent);
        }
        if (status === "closed") {
          const confirmEvent: typeof event = {
            ...event,
            id: id(),
            action: "confirm",
            fromStatus: "awaiting_confirmation",
            toStatus: "closed",
            reason: "演示样例：合成的结束状态，不代表居民确认或真实维修质量。",
          };
          this.store.audit(ticketId, confirmEvent);
        }
      }
      this.store.put<ExampleBatch>("demo_fixture", {
        id: batchId,
        siteId: "demo",
        ticketIds,
        createdAt: new Date(clock).toISOString(),
      });
      return { created: ticketIds.length, existing: 0 };
    });
  }

  routes(app: Express) {
    app.get("/api/staff/analytics", (req, res) => res.json(this.summary(req)));
    app.get("/api/staff/analytics/export", (req, res) => {
      const summary = this.summary(req);
      res
        .set({
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="linli-summary.csv"',
          "Cache-Control": "no-store",
        })
        .send(this.csv(summary));
    });
    app.post("/api/staff/demo-examples", (req, res) =>
      res.json(this.loadExamples(req)),
    );
  }
}
