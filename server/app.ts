import express from "express";
import helmet from "helmet";
import { unlinkSync } from "node:fs";
import type { AiService, Bootstrap, Location, Site } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import { Store } from "./db/index.js";
import { Auth } from "./auth/index.js";
import { Tasks } from "./tasks/index.js";
import { Drafts, type StoredDraft } from "./drafts/index.js";
import { Tickets } from "./tickets/index.js";
import { Operations } from "./operations/index.js";
import { Uploads, type Attachment } from "./uploads/index.js";
import { ApiError, errorHandler, fail, id, rateLimit } from "./http/index.js";
import { DEMO_ACCOUNTS } from "../shared/demo-accounts.js";

export function createApp({
  config,
  ai,
}: {
  config: AppConfig;
  ai: AiService;
}) {
  const store = new Store(config.dbPath),
    app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.locals.requestId = id();
    res.set("X-Request-Id", res.locals.requestId);
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    helmet({ contentSecurityPolicy: config.production ? undefined : false }),
  );
  const sites: Site[] = config.demoMode
    ? [
        {
          id: "demo",
          name: "青禾社区 · 演示空间",
          emergency:
            "如遇即时危险，请远离危险区域并联系现场值班人员；火警拨打 119、紧急救助拨打 120。此入口不提供应急响应。",
          demo: true,
        },
      ]
    : [
        {
          id: "pilot",
          name: "青禾社区",
          emergency:
            "如遇即时危险，请远离危险区域并使用现场公示的应急渠道。此入口不提供应急响应。",
          demo: false,
        },
      ];
  const locations: Location[] = sites.flatMap((site) => [
    { id: `${site.id}-entrance`, siteId: site.id, name: "一号楼入口" },
    { id: `${site.id}-corridor`, siteId: site.id, name: "二号楼一层走廊" },
    { id: `${site.id}-garden`, siteId: site.id, name: "中心花园" },
    { id: `${site.id}-square`, siteId: site.id, name: "社区活动广场" },
  ]);
  for (const site of sites) store.put("site", site);
  for (const location of locations) store.put("location", location);
  let secondStaffUsername = `${config.staffUsername.slice(0, 31)}2`;
  const reservedUsernames = new Set([
    config.staffUsername.toLowerCase(),
    config.adminUsername.toLowerCase(),
  ]);
  for (let n = 2; reservedUsernames.has(secondStaffUsername.toLowerCase()); n++)
    secondStaffUsername = `staff-${n}`;
  const auth = new Auth(store, {
    secureCookies: config.production,
    origin: config.origin,
    seedAccounts: [
      {
        id: `${sites[0]!.id}-admin-1`,
        username: config.adminUsername,
        password: config.adminPassword,
        name: "社区管理员",
        siteId: sites[0]!.id,
        role: "admin",
      },
      {
        id: `${sites[0]!.id}-staff-1`,
        username: config.staffUsername,
        password: config.staffPassword,
        name: "林师傅",
        siteId: sites[0]!.id,
        role: "staff",
      },
      ...(config.demoMode
        ? [
            {
              id: "demo-resident-1",
              username: DEMO_ACCOUNTS[0]!.username,
              password: DEMO_ACCOUNTS[0]!.password,
              name: "演示居民",
              siteId: "demo",
              role: "resident" as const,
            },
            {
              id: "demo-staff-2",
              username: secondStaffUsername,
              password: config.staffPassword,
              name: "周师傅",
              siteId: "demo",
              role: "staff" as const,
            },
          ]
        : []),
    ],
  });
  app.use(auth.csrf);
  app.use("/api", auth.refresh);
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", rateLimit(240, 60000));
  auth.routes(
    app,
    sites.map((s) => s.id),
  );
  const tasks = new Tasks(store, auth, config.ai.model);
  let drafts: Drafts, tickets: Tickets;
  const uploads = new Uploads(
    store,
    auth,
    config.uploadDir,
    (req, target, write) => {
      if (target.draftId) {
        const draft = drafts.get(req, target.draftId);
        if (write && draft.submittedTicketId)
          fail(409, "DRAFT_SUBMITTED", "此草稿已提交，不能更改图片。");
        return { siteId: draft.siteId, ownerId: draft.ownerId };
      }
      const access = tickets.access(req, target.ticketId!);
      if (write) {
        const staff = tickets.currentStaff(req, access.ticket, true);
        tickets.assertState(access.ticket, ["processing"]);
        return { siteId: access.ticket.siteId, ownerId: staff.id };
      }
      return { siteId: access.ticket.siteId, ownerId: access.ticket.ownerId };
    },
    (req, draftId, attachmentId) =>
      drafts.bindIntake(req, draftId, attachmentId),
  );
  drafts = new Drafts(store, auth, tasks, uploads, ai, config, locations);
  tickets = new Tickets(
    store,
    auth,
    drafts,
    tasks,
    uploads,
    ai,
    config,
    sites,
    locations,
  );
  app.get("/api/bootstrap", (req, res) => {
    const staff = auth.read(req, "staff") as
      | import("./auth/index.js").Staff
      | undefined;
    const bootstrap: Bootstrap = {
      sites,
      locations,
      staff: staff
        ? {
            id: staff.id,
            name: staff.name,
            username: staff.username,
            siteId: staff.siteId,
            role: staff.role,
          }
        : null,
      user: auth.current(req) ? auth.view(auth.current(req)!) : null,
      guestId: auth.legacyGuest(req)?.id || null,
      demoMode: config.demoMode,
      ai: { enabled: config.ai.mode === "live", model: config.ai.model },
      features: {
        semantic: config.semanticEnabled,
        receiptCheck: config.receiptCheckEnabled,
        responseItems: config.responseItemsEnabled,
      },
    };
    res.json(bootstrap);
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", auth.requireAccount);
  drafts.routes(app);
  tickets.routes(app);
  new Operations(store, auth, config, sites, locations).routes(app);
  tasks.routes(app);
  uploads.routes(app);
  app.use("/api", (_req, _res, next) =>
    next(new ApiError(404, "NOT_FOUND", "没有找到此接口。")),
  );
  app.use(errorHandler);
  const cleanup = () => {
    const cutoff = Date.now() - 86400000;
    for (const run of store.all<{ id: string; createdAt: string }>("ai_run"))
      if (Date.parse(run.createdAt) < Date.now() - 7 * 86400000)
        store.remove("ai_run", run.id);
    for (const task of store.all<{ id: string; createdAt: string }>("task"))
      if (Date.parse(task.createdAt) < Date.now() - 7 * 86400000)
        store.remove("task", task.id);
    store.db
      .prepare(
        "DELETE FROM credentials WHERE json_extract(data,'$.expiresAt') < ?",
      )
      .run(new Date().toISOString());
    for (const ticket of store.all<import("../shared/types.js").Ticket>(
      "ticket",
    )) {
      const terminalAt =
        ticket.status === "closed"
          ? ticket.closedAt
          : ticket.status === "withdrawn"
            ? ticket.updatedAt
            : null;
      const retentionCutoff = Date.now() - 30 * 86400000;
      const terminalExpired =
        !!terminalAt && Date.parse(terminalAt) <= retentionCutoff;
      const pilotExpired =
        !["closed", "withdrawn"].includes(ticket.status) &&
        store.get<Site>("site", ticket.siteId)?.demo === false &&
        !!config.pilotEndAt &&
        Date.parse(config.pilotEndAt) <= retentionCutoff;
      if (!terminalExpired && !pilotExpired) continue;
      const submittedDrafts = store
        .all<StoredDraft>("draft")
        .filter((d) => d.submittedTicketId === ticket.id);
      const draftIds = new Set(submittedDrafts.map((d) => d.id));
      const originalDraftId = (ticket as typeof ticket & { draftId?: string })
        .draftId;
      if (originalDraftId) draftIds.add(originalDraftId);
      const files = store
        .all<Attachment>("attachment")
        .filter(
          (a) =>
            a.ticketId === ticket.id ||
            (!!a.draftId && draftIds.has(a.draftId)) ||
            (!!a.originatingDraftId && draftIds.has(a.originatingDraftId)),
        );
      const linkedTasks = store
        .all<{ id: string; ticketId?: string; draftId?: string }>("task")
        .filter(
          (t) =>
            t.ticketId === ticket.id ||
            (!!t.draftId && draftIds.has(t.draftId)),
        );
      store.tx(() => {
        store.remove("ticket", ticket.id);
        store.db.prepare("DELETE FROM audit WHERE ticket_id=?").run(ticket.id);
        store.db
          .prepare(
            "DELETE FROM idempotency WHERE json_extract(data,'$.ticket.id')=?",
          )
          .run(ticket.id);
        for (const value of store.all<{ id: string; ticketId?: string }>(
          "receipt_draft_history",
        ))
          if (value.ticketId === ticket.id)
            store.remove("receipt_draft_history", value.id);
        for (const task of linkedTasks) {
          store.remove("task", task.id);
          store.remove("ai_run", task.id);
        }
        for (const draft of submittedDrafts) store.remove("draft", draft.id);
        for (const attachment of files)
          store.remove("attachment", attachment.id);
      });
      for (const attachment of files)
        try {
          unlinkSync(attachment.path);
        } catch {}
    }
    for (const attachment of store.all<Attachment>("attachment")) {
      const origin = attachment.draftId || attachment.originatingDraftId;
      if (
        attachment.ticketId ||
        !origin ||
        Date.parse(attachment.createdAt) >= cutoff
      )
        continue;
      const draft = store.get<StoredDraft>("draft", origin);
      const submitted =
        draft?.submittedTicketId ||
        store
          .all<{ id: string; draftId?: string }>("ticket")
          .some((t) => t.draftId === origin);
      if (submitted || draft?.attachmentIds.includes(attachment.id)) continue;
      store.remove("attachment", attachment.id);
      try {
        unlinkSync(attachment.path);
      } catch {}
    }
    for (const draft of store.all<StoredDraft>("draft"))
      if (!draft.submittedTicketId && Date.parse(draft.updatedAt) < cutoff) {
        store.remove("draft", draft.id);
        for (const item of store.all<Attachment>("attachment"))
          if (
            (item.draftId === draft.id ||
              item.originatingDraftId === draft.id) &&
            !item.ticketId
          ) {
            store.remove("attachment", item.id);
            try {
              unlinkSync(item.path);
            } catch {}
          }
      }
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, 3600000);
  cleanupTimer.unref();
  let closed = false;
  return {
    app,
    db: store.db,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(cleanupTimer);
      tasks.close();
      store.close();
    },
  };
}
