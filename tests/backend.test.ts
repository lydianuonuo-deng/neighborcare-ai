import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import type { AiService, ReceiptCheckInput } from "../shared/types.js";

const fakeAi: AiService = {
  analyze: async (input) => ({
    category: "lighting",
    facts: [
      {
        id: "f1",
        text: "楼道灯晚上不亮",
        origin: "reported",
        evidenceRefs: [`text:${input.description}`],
        needsConfirmation: true,
      },
    ],
    gap: null,
    needsReview: false,
  }),
  checkReceipt: async (input) => ({
    rows: input.items.map((i) => ({
      itemId: i.id,
      status: "response_found",
      receiptTextRefs: [input.segments[0]!.id],
      explanation: "回执交代了处理情况。",
    })),
  }),
};
const photo = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: "#888888" } })
    .png()
    .toBuffer();
function fixture(
  ai: AiService = fakeAi,
  overrides: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "linli-test-"));
  const config = {
    ...loadConfig({
      DB_PATH: join(dir, "test.sqlite"),
      UPLOAD_DIR: join(dir, "uploads"),
    }),
    dbPath: join(dir, "test.sqlite"),
    uploadDir: join(dir, "uploads"),
    origin: "http://localhost:3030",
    ...overrides,
  };
  let instance = createApp({ config, ai });
  return {
    get instance() {
      return instance;
    },
    restart(overrides: Record<string, unknown> = {}) {
      instance.close();
      Object.assign(config, overrides);
      instance = createApp({ config, ai });
    },
    close() {
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function resident(f: ReturnType<typeof fixture>) {
  const a = request.agent(f.instance.app);
  assert.equal(
    (
      await a
        .post("/api/auth/register")
        .send({
          siteId: "demo",
          username: `resident_${randomUUID().slice(0, 8)}`,
          name: "居民",
          password: "ResidentPassword-2026!",
        })
    ).status,
    201,
  );
  return a;
}
async function staff(f: ReturnType<typeof fixture>, username = "demo") {
  const a = request.agent(f.instance.app);
  const response = await a
    .post("/api/staff/sessions")
    .send({ username, password: "LinliDemo-2026!" });
  assert.equal(response.status, 200);
  return a;
}
async function draft(a: ReturnType<typeof request.agent>) {
  const response = await a.post("/api/drafts").send({
    siteId: "demo",
    description: "楼道灯晚上不亮",
    locationId: "demo-entrance",
    category: "lighting",
  });
  assert.equal(response.status, 201);
  return response.body;
}
async function submit(
  a: ReturnType<typeof request.agent>,
  d: any,
  key = randomUUID(),
) {
  const body = {
    draftId: d.id,
    version: d.version,
    description: d.description,
    locationId: d.locationId,
    category: d.category,
    confirmed: true,
    idempotencyKey: key,
  };
  const response = await a.post("/api/tickets").send(body);
  assert.equal(response.status, 201);
  return { ticket: response.body.ticket, body };
}
async function event(
  a: ReturnType<typeof request.agent>,
  t: any,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return a.post(`/api/tickets/${t.id}/events`).send({
    action,
    version: t.version,
    idempotencyKey: randomUUID(),
    ...extra,
  });
}
async function receiptDraft(a: ReturnType<typeof request.agent>, t: any) {
  const uploaded = await a
    .post("/api/attachments")
    .field("ticketId", t.id)
    .field("purpose", "receipt")
    .attach("file", await photo(), "after.png");
  assert.equal(uploaded.status, 201);
  const input = {
    version: t.version,
    items: [
      {
        id: "light",
        text: "楼道灯夜间照明的处理情况",
        sourceRefs: [
          {
            source: "submission",
            sourceId: t.submissionId,
            quote: "楼道灯晚上不亮",
          },
        ],
      },
    ],
    description: "该楼道灯已更换灯泡，夜间效果待复查。",
    attachmentIds: [uploaded.body.id],
  };
  const saved = await a.put(`/api/tickets/${t.id}/receipt-draft`).send(input);
  assert.equal(saved.status, 200);
  return { draft: saved.body, input };
}
async function waitTask(a: ReturnType<typeof request.agent>, task: any) {
  for (let n = 0; n < 40; n++) {
    const result = await a.get(`/api/tasks/${task.id}`);
    assert.equal(result.status, 200);
    if (result.body.state === "succeeded" || result.body.state === "failed")
      return result.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("task did not finish");
}

test("registered ownership and cookie survive a SQLite restart; public links grant no access", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a),
      submitted = await submit(a, d);
    // The credential itself is persisted; a new HTTP agent can resend the original cookie.
    const first = await request(f.instance.app)
      .post("/api/auth/register")
      .send({
        siteId: "demo",
        username: "restart_resident",
        name: "居民",
        password: "ResidentPassword-2026!",
      });
    const owned = await request(f.instance.app)
      .post("/api/drafts")
      .set("Cookie", first.headers["set-cookie"])
      .send({ description: "长椅有裂纹", locationId: "demo-garden" });
    assert.equal(owned.status, 201);
    f.restart();
    const restored = await request(f.instance.app)
      .get(`/api/drafts/${owned.body.id}`)
      .set("Cookie", first.headers["set-cookie"]);
    assert.equal(restored.status, 200);
    assert.equal(
      (await request(f.instance.app).get(`/api/tickets/${submitted.ticket.id}`))
        .status,
      401,
    );
    const stranger = await resident(f);
    assert.equal(
      (await stranger.get(`/api/tickets/${submitted.ticket.id}`)).status,
      403,
    );
  } finally {
    f.close();
  }
});

test("ten simultaneous submits create one ticket; changed key content conflicts; lost response recovers", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a),
      key = randomUUID(),
      body = {
        draftId: d.id,
        version: d.version,
        description: d.description,
        locationId: d.locationId,
        category: d.category,
        confirmed: true,
        idempotencyKey: key,
      };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => a.post("/api/tickets").send(body)),
    );
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.ticket.id)).size, 1);
    const list = await a.get("/api/me/tickets");
    assert.equal(list.body.tickets.length, 1);
    assert.equal(
      (await a.post("/api/tickets").send({ ...body, description: "换了内容" }))
        .status,
      409,
    );
    const recovered = await a.get(`/api/submissions/${key}`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.ticket.id, results[0]!.body.ticket.id);
  } finally {
    f.close();
  }
});

test("authorization and same-origin checks protect drafts, uploads, tasks, staff and resident actions", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      b = await resident(f),
      d = await draft(a);
    assert.equal((await b.get(`/api/drafts/${d.id}`)).status, 403);
    assert.equal(
      (
        await a
          .patch(`/api/drafts/${d.id}`)
          .set("Origin", "https://evil.example")
          .send({ version: 1, description: "x" })
      ).status,
      403,
    );
    const upload = await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "intake")
      .attach("file", await photo(), "before.png");
    assert.equal(upload.status, 201);
    assert.equal(
      (await b.get(`/api/attachments/${upload.body.id}`)).status,
      403,
    );
    const current = (await a.get(`/api/drafts/${d.id}`)).body;
    const task = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: current.version, consent: true });
    assert.equal(task.status, 202);
    assert.equal((await b.get(`/api/tasks/${task.body.id}`)).status, 403);
    const { ticket } = await submit(a, current),
      s = await staff(f);
    assert.equal((await event(s, ticket, "confirm")).status, 403);
  } finally {
    f.close();
  }
});

test("only one of two staff can claim and only the assignee can change progress", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      { ticket } = await submit(a, await draft(a)),
      s1 = await staff(f),
      s2 = await staff(f, "demo2");
    const result = await Promise.all([
      event(s1, ticket, "claim"),
      event(s2, ticket, "claim"),
    ]);
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    const winner = result[0]!.status === 200 ? s1 : s2,
      loser = winner === s1 ? s2 : s1,
      current = result.find((r) => r.status === 200)!.body.ticket;
    assert.equal(
      (await event(loser, current, "progress", { reason: "检查中" })).status,
      403,
    );
    assert.equal(
      (await event(winner, current, "progress", { reason: "正在现场核对" }))
        .status,
      200,
    );
  } finally {
    f.close();
  }
});

test("request-info restores prior state; return and reopen clear assignee and preserve history", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (
      await event(s, ticket, "request_info", { reason: "请补充所在楼栋" })
    ).body.ticket;
    assert.equal(ticket.status, "needs_info");
    assert.equal(ticket.assigneeId, null);
    ticket = (
      await event(a, ticket, "reply_info", { reason: "位于一号楼入口处" })
    ).body.ticket;
    assert.equal(ticket.status, "pending");
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const owner = ticket.assigneeId;
    ticket = (
      await event(s, ticket, "request_info", { reason: "请说明问题出现的时间" })
    ).body.ticket;
    ticket = (
      await event(a, ticket, "reply_info", { reason: "晚上出现，白天无法确认" })
    ).body.ticket;
    assert.equal(ticket.status, "processing");
    assert.equal(ticket.assigneeId, owner);
    ticket = (
      await event(s, ticket, "return", { reason: "需要其他专业人员处理" })
    ).body.ticket;
    assert.equal(ticket.status, "pending");
    assert.equal(ticket.assigneeId, null);
    assert.equal(ticket.events.length, 7);
  } finally {
    f.close();
  }
});

test("receipt source references reject other tickets and staff text; publication freezes valid mappings", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const saved = await receiptDraft(s, ticket);
    const invalid = {
      ...saved.input,
      draftVersion: saved.draft.version,
      scopeVersion: saved.draft.scopeVersion,
      items: [
        {
          id: "fake",
          text: "非法事项",
          sourceRefs: [
            {
              source: "submission",
              sourceId: randomUUID(),
              quote: "楼道灯晚上不亮",
            },
          ],
        },
      ],
    };
    assert.equal(
      (await s.put(`/api/tickets/${ticket.id}/receipt-draft`).send(invalid))
        .status,
      422,
    );
    const check = await s
      .post(`/api/tickets/${ticket.id}/receipt-draft/check`)
      .send({
        version: ticket.version,
        draftVersion: saved.draft.version,
        scopeVersion: saved.draft.scopeVersion,
      });
    assert.equal(check.status, 202);
    assert.equal((await waitTask(s, check.body)).state, "succeeded");
    assert.equal(
      (await a.get(`/api/tickets/${ticket.id}`)).body.receiptDraft,
      null,
    );
    const publishBody = {
      action: "receipt",
      version: ticket.version,
      idempotencyKey: randomUUID(),
      draftVersion: saved.draft.version,
      scopeVersion: saved.draft.scopeVersion,
    };
    const publication = await s
      .post(`/api/tickets/${ticket.id}/events`)
      .send(publishBody);
    assert.equal(publication.status, 200);
    ticket = publication.body.ticket;
    assert.equal(
      ticket.currentReceipt.coverage.rows[0].status,
      "response_found",
    );
    assert.equal(
      (await s.post(`/api/tickets/${ticket.id}/events`).send(publishBody))
        .status,
      200,
    );
    const snapshot = structuredClone(ticket.currentReceipt);
    const closed = await event(a, ticket, "confirm", {
      receiptId: snapshot.id,
      receiptVersion: snapshot.version,
    });
    assert.equal(closed.status, 200);
    ticket = closed.body.ticket;
    const reopen = {
      action: "reopen",
      version: ticket.version,
      idempotencyKey: randomUUID(),
      receiptId: snapshot.id,
      receiptVersion: snapshot.version,
      scopeVersion: snapshot.scopeVersion,
      feedbackKind: "items",
      itemIds: ["light"],
    };
    const reopened = await a
      .post(`/api/tickets/${ticket.id}/events`)
      .send(reopen);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.ticket.status, "pending");
    assert.equal(reopened.body.ticket.assigneeId, null);
    assert.deepEqual(reopened.body.ticket.currentReceipt, snapshot);
    assert.equal(
      reopened.body.event.feedback.itemTexts[0],
      saved.input.items[0]!.text,
    );
    assert.equal(
      (await a.post(`/api/tickets/${ticket.id}/events`).send(reopen)).status,
      200,
    );
    assert.equal(
      (
        await a
          .post(`/api/tickets/${ticket.id}/events`)
          .send({ ...reopen, itemIds: ["missing"] })
      ).status,
      409,
    );
  } finally {
    f.close();
  }
});

test("late receipt checks cannot overwrite edited drafts or attach to a published manual receipt", async () => {
  let resolveCheck!: (value: any) => void;
  const delayed: AiService = {
    ...fakeAi,
    checkReceipt: (input) =>
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
  };
  const f = fixture(delayed);
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const saved = await receiptDraft(s, ticket);
    const task = await s
      .post(`/api/tickets/${ticket.id}/receipt-draft/check`)
      .send({
        version: ticket.version,
        draftVersion: saved.draft.version,
        scopeVersion: saved.draft.scopeVersion,
      });
    await new Promise((r) => setTimeout(r, 5));
    const edited = await s.put(`/api/tickets/${ticket.id}/receipt-draft`).send({
      ...saved.input,
      draftVersion: 1,
      scopeVersion: 1,
      description: "该灯暂未处理，等待专业人员检查。",
    });
    assert.equal(edited.status, 200);
    resolveCheck({
      rows: [
        {
          itemId: "light",
          status: "response_found",
          receiptTextRefs: ["s1"],
          explanation: "有回应",
        },
      ],
    });
    assert.equal((await waitTask(s, task.body)).state, "failed");
    const current = await s.get(`/api/tickets/${ticket.id}`);
    assert.equal(current.body.receiptDraft.check, null);
    const published = await event(s, ticket, "receipt", {
      draftVersion: edited.body.version,
      scopeVersion: edited.body.scopeVersion,
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.ticket.currentReceipt.coverage, null);
  } finally {
    f.close();
  }
});

test("F13 special feedback is exclusive and requires text; F13 disabled retains legacy reason reopen", async () => {
  const f = fixture(fakeAi, {
    responseItemsEnabled: false,
    receiptCheckEnabled: false,
  });
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const saved = await receiptDraft(s, ticket);
    ticket = (
      await event(s, ticket, "receipt", {
        draftVersion: saved.draft.version,
        scopeVersion: saved.draft.scopeVersion,
      })
    ).body.ticket;
    const result = await event(a, ticket, "reopen", {
      receiptId: ticket.currentReceipt.id,
      receiptVersion: ticket.currentReceipt.version,
      reason: "夜间灯仍然不亮",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ticket.status, "pending");
  } finally {
    f.close();
  }
});

test("clarification counts and stop reasons persist across edits and repeated answers", async () => {
  const ai: AiService = {
    ...fakeAi,
    analyze: async (input) => ({
      ...(await fakeAi.analyze(input)),
      gap: { kind: "object", factIds: ["f1"], policyId: "object-1" },
    }),
  };
  const f = fixture(ai, { semanticEnabled: true });
  try {
    const a = await resident(f);
    let d = await draft(a);
    let task = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: d.version, consent: true });
    await waitTask(a, task.body);
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.semanticCount, 1);
    assert.equal(d.clarificationCount, 1);
    const body = {
      version: d.version,
      answer: {
        questionId: d.question.id,
        inputVersion: d.version,
        kind: "not_sure",
      },
    };
    const answered = await a.patch(`/api/drafts/${d.id}`).send(body);
    assert.equal(answered.status, 200);
    assert.equal(answered.body.stopReason, "not_sure");
    assert.equal((await a.patch(`/api/drafts/${d.id}`).send(body)).status, 200);
    assert.equal(
      (
        await a
          .patch(`/api/drafts/${d.id}`)
          .send({ ...body, answer: { ...body.answer, kind: "skip" } })
      ).status,
      409,
    );
    d = (
      await a.patch(`/api/drafts/${d.id}`).send({
        version: answered.body.version,
        description: "楼道灯具晚上不亮",
      })
    ).body;
    task = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: d.version, consent: true });
    await waitTask(a, task.body);
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.question, null);
    assert.equal(d.stopReason, "not_sure");
    assert.equal(d.semanticCount, 1);
    await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "later.png");
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.stopReason, "not_sure");
    assert.equal(d.clarificationCount, 1);
    assert.equal(d.semanticCount, 1);
    const submission = await submit(a, d);
    assert.equal(submission.ticket.stopReason, "not_sure");
    assert.equal(submission.ticket.needsReview, true);
  } finally {
    f.close();
  }
});

test("uploads verify image bytes, strip metadata, enforce quota and release removed slots", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a);
    assert.equal(
      (
        await request(f.instance.app)
          .post("/api/attachments")
          .field("draftId", d.id)
          .field("purpose", "draft")
          .attach("file", await photo(), "x.png")
      ).status,
      401,
    );
    assert.equal(
      (
        await a
          .post("/api/attachments")
          .field("draftId", d.id)
          .field("purpose", "draft")
          .attach("file", Buffer.from("<svg><script/></svg>"), "pretend.png")
      ).status,
      422,
    );
    const files = [];
    for (let i = 0; i < 3; i++) {
      const r = await a
        .post("/api/attachments")
        .field("draftId", d.id)
        .field("purpose", "draft")
        .attach("file", await photo(), `现场${i}.png`);
      assert.equal(r.status, 201);
      assert.ok(r.body.fileName);
      assert.equal(r.body.mime, "image/webp");
      assert.equal(r.body.path, undefined);
      files.push(r.body);
    }
    assert.equal(
      (
        await a
          .post("/api/attachments")
          .field("draftId", d.id)
          .field("purpose", "draft")
          .attach("file", await photo(), "fourth.png")
      ).status,
      422,
    );
    const latest = (await a.get(`/api/drafts/${d.id}`)).body;
    const patch = await a
      .patch(`/api/drafts/${d.id}`)
      .send({ version: latest.version, attachmentIds: files.map((p) => p.id) });
    assert.equal(patch.status, 200);
    const removed = await a.patch(`/api/drafts/${d.id}`).send({
      version: patch.body.version,
      attachmentIds: files.slice(1).map((p) => p.id),
    });
    assert.equal(removed.status, 200);
    assert.equal(
      (await a.delete(`/api/attachments/${files[0].id}`)).status,
      204,
    );
    const fresh = await a.get(`/api/drafts/${d.id}`);
    assert.equal(fresh.body.version, removed.body.version);
    const replacement = await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "replacement.png");
    assert.equal(replacement.status, 201);
    const binary = await a.get(`/api/attachments/${files[1].id}`);
    assert.equal(binary.status, 200);
    const metadata = await sharp(binary.body).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.format, "webp");
  } finally {
    f.close();
  }
});

test("F13 validates latest scope, excludes mixed options, and honors seven-day reopening limit", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const saved = await receiptDraft(s, ticket);
    ticket = (
      await event(s, ticket, "receipt", {
        draftVersion: saved.draft.version,
        scopeVersion: saved.draft.scopeVersion,
      })
    ).body.ticket;
    const binding = {
      receiptId: ticket.currentReceipt.id,
      receiptVersion: ticket.currentReceipt.version,
      scopeVersion: ticket.currentReceipt.scopeVersion,
    };
    assert.equal(
      (
        await event(a, ticket, "reopen", {
          ...binding,
          feedbackKind: "other",
          itemIds: ["light"],
          reason: "其他问题",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await event(a, ticket, "reopen", {
          ...binding,
          feedbackKind: "not_sure",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await event(a, ticket, "reopen", {
          ...binding,
          feedbackKind: "items",
          itemIds: ["bogus"],
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await event(a, ticket, "reopen", {
          ...binding,
          scopeVersion: 99,
          feedbackKind: "items",
          itemIds: ["light"],
        })
      ).status,
      409,
    );
    ticket = (await event(a, ticket, "confirm", binding)).body.ticket;
    const row = f.instance.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get("ticket", ticket.id) as { data: string };
    const data = JSON.parse(row.data);
    data.closedAt = new Date(Date.now() - 8 * 86400000).toISOString();
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
      .run(JSON.stringify(data), "ticket", ticket.id);
    const expired = await event(a, ticket, "reopen", {
      ...binding,
      feedbackKind: "items",
      itemIds: ["light"],
    });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, "REOPEN_EXPIRED");
  } finally {
    f.close();
  }
});

test("staff progress cannot become a resident source; invalid coverage retains manual publication", async () => {
  const invalidAi: AiService = {
    ...fakeAi,
    checkReceipt: async () => ({
      rows: [
        {
          itemId: "not-in-scope",
          status: "response_found",
          receiptTextRefs: ["missing"],
          explanation: "非法映射",
        },
      ],
    }),
  };
  const f = fixture(invalidAi);
  try {
    const a = await resident(f),
      s = await staff(f);
    let { ticket } = await submit(a, await draft(a));
    ticket = (await event(s, ticket, "claim")).body.ticket;
    const progress = await event(s, ticket, "progress", {
      reason: "楼道灯晚上不亮",
    });
    ticket = progress.body.ticket;
    const saved = await receiptDraft(s, ticket);
    const source = {
      ...saved.input,
      draftVersion: 1,
      scopeVersion: 1,
      items: [
        {
          id: "light",
          text: "说明情况",
          sourceRefs: [
            {
              source: "supplement",
              sourceId: progress.body.event.id,
              quote: "楼道灯晚上不亮",
            },
          ],
        },
      ],
    };
    assert.equal(
      (await s.put(`/api/tickets/${ticket.id}/receipt-draft`).send(source))
        .status,
      422,
    );
    const task = await s
      .post(`/api/tickets/${ticket.id}/receipt-draft/check`)
      .send({ version: ticket.version, draftVersion: 1, scopeVersion: 1 });
    assert.equal((await waitTask(s, task.body)).state, "failed");
    const retry = await s
      .post(`/api/tickets/${ticket.id}/receipt-draft/check`)
      .send({ version: ticket.version, draftVersion: 1, scopeVersion: 1 });
    assert.equal(retry.body.id, task.body.id);
    const publication = await event(s, ticket, "receipt", {
      draftVersion: 1,
      scopeVersion: 1,
    });
    assert.equal(publication.status, 200);
    assert.equal(publication.body.ticket.currentReceipt.coverage, null);
  } finally {
    f.close();
  }
});

test("late intake results cannot overwrite edited input; hard clarification count reaches its cap", async () => {
  let release!: (v: any) => void;
  const ai: AiService = {
    ...fakeAi,
    analyze: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const f = fixture(ai, { semanticEnabled: true });
  try {
    const a = await resident(f);
    let d = (
      await a
        .post("/api/drafts")
        .send({ description: "楼道灯晚上不亮", category: "lighting" })
    ).body;
    const task = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: 1, consent: true });
    await new Promise((r) => setTimeout(r, 5));
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.question.kind, "location");
    assert.equal(d.clarificationCount, 1);
    const edited = await a
      .patch(`/api/drafts/${d.id}`)
      .send({ version: d.version, description: "花园长椅存在裂纹" });
    assert.equal(edited.status, 200);
    release(
      await fakeAi.analyze({
        description: "楼道灯晚上不亮",
        category: "lighting",
        images: [],
        inputVersion: 1,
      }),
    );
    assert.equal((await waitTask(a, task.body)).state, "failed");
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.description, "花园长椅存在裂纹");
    assert.equal(d.analysis, null);
    assert.equal(d.clarificationCount, 1);
    const task2 = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: d.version, consent: true });
    await new Promise((r) => setTimeout(r, 5));
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.clarificationCount, 2);
    const answer = {
      questionId: d.question.id,
      inputVersion: d.version,
      kind: "skip",
    };
    const answered = await a
      .patch(`/api/drafts/${d.id}`)
      .send({ version: d.version, answer });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.stopReason, "skip");
    release(
      await fakeAi.analyze({
        description: d.description,
        category: "lighting",
        images: [],
        inputVersion: d.version,
      }),
    );
    await waitTask(a, task2.body);
    const stale = await a.patch(`/api/drafts/${d.id}`).send({
      version: answered.body.version,
      answer: { ...answer, kind: "text", value: "demo-garden" },
    });
    assert.equal(stale.status, 409);
  } finally {
    f.close();
  }
});

test("emergency text stops ordinary flow; negative and normal lighting descriptions remain usable", async () => {
  const f = fixture();
  try {
    const a = await resident(f);
    const danger = await a
      .post("/api/drafts")
      .send({ description: "闻到燃气味" });
    assert.equal(danger.status, 422);
    assert.equal(danger.body.error.code, "EMERGENCY");
    assert.equal(
      (
        await a
          .post("/api/drafts")
          .send({ description: "没有闻到燃气味，楼道灯晚上不亮" })
      ).status,
      201,
    );
    const d = await draft(a);
    assert.equal(
      (
        await a
          .patch(`/api/drafts/${d.id}`)
          .send({ version: d.version, description: "这里正在冒烟" })
      ).body.error.code,
      "EMERGENCY",
    );
  } finally {
    f.close();
  }
});

test("fresh analysis after editing preserves current facts in the confirmed ticket", async () => {
  const f = fixture();
  try {
    const a = await resident(f);
    let d = (await a.post("/api/drafts").send({ siteId: "demo" })).body;
    d = (
      await a.patch(`/api/drafts/${d.id}`).send({
        version: d.version,
        description: "楼道灯晚上不亮",
        locationId: "demo-entrance",
        category: "lighting",
      })
    ).body;
    const task = await a
      .post(`/api/drafts/${d.id}/analyze`)
      .send({ version: d.version, consent: true });
    assert.equal((await waitTask(a, task.body)).state, "succeeded");
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(d.analysis.facts.length, 1);
    const { ticket } = await submit(a, d);
    assert.equal(ticket.facts.length, 1);
    assert.equal(ticket.facts[0].id, "f1");
  } finally {
    f.close();
  }
});

test("deleting an unsubmitted draft removes its attachment metadata and private file", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a);
    const uploaded = await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "before.png");
    assert.equal(uploaded.status, 201);
    const row = f.instance.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get("attachment", uploaded.body.id) as { data: string };
    const path = JSON.parse(row.data).path;
    assert.ok(existsSync(path));
    assert.equal((await a.delete(`/api/drafts/${d.id}`)).status, 204);
    assert.equal(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("attachment", uploaded.body.id),
      undefined,
    );
    assert.equal(existsSync(path), false);
  } finally {
    f.close();
  }
});

test("retention preserves transferred ticket photos and removes expired terminal tickets with all references", async () => {
  const f = fixture();
  try {
    const a = await resident(f);
    let d = await draft(a);
    const upload = await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "before.png");
    assert.equal(upload.status, 201);
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    const { ticket } = await submit(a, d);
    const image = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("attachment", upload.body.id) as { data: string }
      ).data,
    );
    const savedDraft = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("draft", d.id) as { data: string }
      ).data,
    );
    savedDraft.updatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
      .run(JSON.stringify(savedDraft), "draft", d.id);
    f.restart();
    assert.ok(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("ticket", ticket.id),
    );
    assert.ok(existsSync(image.path));
    const current = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("ticket", ticket.id) as { data: string }
      ).data,
    );
    current.status = "withdrawn";
    current.updatedAt = new Date(Date.now() - 31 * 86400000).toISOString();
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
      .run(JSON.stringify(current), "ticket", ticket.id);
    f.restart();
    assert.equal(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("ticket", ticket.id),
      undefined,
    );
    assert.equal(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("attachment", upload.body.id),
      undefined,
    );
    assert.equal(existsSync(image.path), false);
    assert.equal(
      f.instance.db
        .prepare("SELECT data FROM audit WHERE ticket_id=?")
        .get(ticket.id),
      undefined,
    );
    assert.equal(
      f.instance.db
        .prepare(
          "SELECT data FROM idempotency WHERE json_extract(data,'$.ticket.id')=?",
        )
        .get(ticket.id),
      undefined,
    );
  } finally {
    f.close();
  }
});

test("concurrent image uploads cannot exceed the three-photo draft allowance", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a),
      buffer = await photo();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        a
          .post("/api/attachments")
          .field("draftId", d.id)
          .field("purpose", "draft")
          .attach("file", buffer, `${i}.png`),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(results.filter((r) => r.status === 422).length, 2);
  } finally {
    f.close();
  }
});

test("pilot-end retention removes open pilot data after thirty days and preserves demo records", async () => {
  const f = fixture();
  try {
    const demo = await resident(f);
    let demoDraft = await draft(demo);
    const demoUpload = await demo
      .post("/api/attachments")
      .field("draftId", demoDraft.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "demo.png");
    assert.equal(demoUpload.status, 201);
    demoDraft = (await demo.get(`/api/drafts/${demoDraft.id}`)).body;
    const demoTicket = (await submit(demo, demoDraft)).ticket;
    const demoImage = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("attachment", demoUpload.body.id) as { data: string }
      ).data,
    );
    f.restart({ demoMode: false });
    const pilot = request.agent(f.instance.app);
    assert.equal(
      (
        await pilot
          .post("/api/auth/register")
          .send({
            siteId: "pilot",
            username: "pilot_resident",
            name: "试点居民",
            password: "ResidentPassword-2026!",
          })
      ).status,
      201,
    );
    let pilotDraft = (
      await pilot.post("/api/drafts").send({
        siteId: "pilot",
        description: "楼道灯晚上不亮",
        category: "lighting",
        locationId: "pilot-entrance",
      })
    ).body;
    const pilotUpload = await pilot
      .post("/api/attachments")
      .field("draftId", pilotDraft.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "pilot.png");
    assert.equal(pilotUpload.status, 201);
    pilotDraft = (await pilot.get(`/api/drafts/${pilotDraft.id}`)).body;
    const task = await pilot
      .post(`/api/drafts/${pilotDraft.id}/analyze`)
      .send({ version: pilotDraft.version, consent: true });
    assert.equal((await waitTask(pilot, task.body)).state, "succeeded");
    const submitted = await submit(pilot, pilotDraft);
    const pilotTicket = submitted.ticket;
    const pilotImage = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("attachment", pilotUpload.body.id) as { data: string }
      ).data,
    );
    assert.equal(pilotTicket.status, "pending");
    assert.ok(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("ai_run", task.body.id),
    );
    f.restart({
      pilotEndAt: new Date(Date.now() - 29 * 86400000).toISOString(),
    });
    assert.ok(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("ticket", pilotTicket.id),
    );
    assert.ok(existsSync(pilotImage.path));
    f.restart({
      pilotEndAt: new Date(Date.now() - 31 * 86400000).toISOString(),
    });
    for (const [kind, entityId] of [
      ["ticket", pilotTicket.id],
      ["draft", pilotDraft.id],
      ["attachment", pilotUpload.body.id],
      ["task", task.body.id],
      ["ai_run", task.body.id],
    ])
      assert.equal(
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get(kind, entityId),
        undefined,
        `${kind} must be removed`,
      );
    assert.equal(existsSync(pilotImage.path), false);
    assert.equal(
      f.instance.db
        .prepare("SELECT data FROM audit WHERE ticket_id=?")
        .get(pilotTicket.id),
      undefined,
    );
    assert.equal(
      f.instance.db
        .prepare(
          "SELECT data FROM idempotency WHERE json_extract(data,'$.ticket.id')=?",
        )
        .get(pilotTicket.id),
      undefined,
    );
    assert.ok(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("ticket", demoTicket.id),
    );
    assert.ok(
      f.instance.db
        .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
        .get("attachment", demoUpload.body.id),
    );
    assert.ok(existsSync(demoImage.path));
  } finally {
    f.close();
  }
});

test("an uploaded intake photo is recoverable after response loss and deletion releases its allowance", async () => {
  const f = fixture();
  try {
    const a = await resident(f),
      d = await draft(a);
    // The client deliberately ignores the upload response and restores only the draft.
    await a
      .post("/api/attachments")
      .field("draftId", d.id)
      .field("purpose", "draft")
      .attach("file", await photo(), "lost-response.png");
    let restored = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(restored.attachments.length, 1);
    assert.equal(restored.version, d.version + 1);
    const imageId = restored.attachments[0].id;
    assert.equal((await a.delete(`/api/attachments/${imageId}`)).status, 204);
    restored = (await a.get(`/api/drafts/${d.id}`)).body;
    assert.equal(restored.attachments.length, 0);
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await a
            .post("/api/attachments")
            .field("draftId", d.id)
            .field("purpose", "draft")
            .attach("file", await photo(), `${i}.png`)
        ).status,
        201,
      );
    assert.equal(
      (await a.get(`/api/drafts/${d.id}`)).body.attachments.length,
      3,
    );
  } finally {
    f.close();
  }
});

test("terminal cleanup removes legacy unselected photos even when their original draft row is absent", async () => {
  const f = fixture();
  try {
    const a = await resident(f);
    let d = await draft(a);
    const images = [];
    for (let i = 0; i < 3; i++) {
      const image = await a
        .post("/api/attachments")
        .field("draftId", d.id)
        .field("purpose", "draft")
        .attach("file", await photo(), `${i}.png`);
      assert.equal(image.status, 201);
      images.push(image.body);
    }
    d = (await a.get(`/api/drafts/${d.id}`)).body;
    d = (
      await a
        .patch(`/api/drafts/${d.id}`)
        .send({ version: d.version, attachmentIds: [] })
    ).body;
    const { ticket } = await submit(a, d);
    const storedImages = images.map((image) =>
      JSON.parse(
        (
          f.instance.db
            .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
            .get("attachment", image.id) as { data: string }
        ).data,
      ),
    );
    for (const image of storedImages) {
      delete image.originatingDraftId;
      f.instance.db
        .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
        .run(JSON.stringify(image), "attachment", image.id);
    }
    const current = JSON.parse(
      (
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("ticket", ticket.id) as { data: string }
      ).data,
    );
    current.status = "withdrawn";
    current.updatedAt = new Date(Date.now() - 31 * 86400000).toISOString();
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
      .run(JSON.stringify(current), "ticket", ticket.id);
    f.instance.db
      .prepare("DELETE FROM objects WHERE kind=? AND id=?")
      .run("draft", d.id);
    f.restart();
    for (const image of storedImages) {
      assert.equal(
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("attachment", image.id),
        undefined,
      );
      assert.equal(existsSync(image.path), false);
    }
  } finally {
    f.close();
  }
});

test("unselected and orphaned legacy draft photos are cleaned after twenty-four hours", async () => {
  const f = fixture();
  try {
    const a = await resident(f);
    const images = [];
    for (let i = 0; i < 2; i++) {
      const d = await draft(a);
      const uploaded = await a
        .post("/api/attachments")
        .field("draftId", d.id)
        .field("purpose", "draft")
        .attach("file", await photo(), `${i}.png`);
      assert.equal(uploaded.status, 201);
      const image = JSON.parse(
        (
          f.instance.db
            .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
            .get("attachment", uploaded.body.id) as { data: string }
        ).data,
      );
      image.createdAt = new Date(Date.now() - 2 * 86400000).toISOString();
      delete image.originatingDraftId;
      f.instance.db
        .prepare("UPDATE objects SET data=? WHERE kind=? AND id=?")
        .run(JSON.stringify(image), "attachment", image.id);
      images.push(image);
      if (i === 0) {
        const current = (await a.get(`/api/drafts/${d.id}`)).body;
        assert.equal(
          (
            await a
              .patch(`/api/drafts/${d.id}`)
              .send({ version: current.version, attachmentIds: [] })
          ).status,
          200,
        );
      } else
        f.instance.db
          .prepare("DELETE FROM objects WHERE kind=? AND id=?")
          .run("draft", d.id);
    }
    f.restart();
    for (const image of images) {
      assert.equal(
        f.instance.db
          .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
          .get("attachment", image.id),
        undefined,
      );
      assert.equal(existsSync(image.path), false);
    }
  } finally {
    f.close();
  }
});
