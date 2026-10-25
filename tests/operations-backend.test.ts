import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { chinaDateKey, DEFAULT_TICKET_FILTERS } from "../shared/operations.js";
import type { AiService, Ticket } from "../shared/types.js";

function fixture(demoMode = true) {
  const dir = mkdtempSync(join(tmpdir(), "linli-operations-"));
  const config = loadConfig({
    DB_PATH: join(dir, "operations.sqlite"),
    UPLOAD_DIR: join(dir, "uploads"),
    DEMO_MODE: String(demoMode),
    STAFF_PASSWORD: "LinliDemo-2026!",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "LinliAdmin-2026!",
  });
  let aiCalls = 0;
  const ai: AiService = {
    analyze: async () => {
      aiCalls++;
      throw new Error("Unexpected AI analysis");
    },
    checkReceipt: async () => {
      aiCalls++;
      throw new Error("Unexpected AI receipt check");
    },
  };
  const instance = createApp({ config, ai });
  return {
    instance,
    config,
    get aiCalls() {
      return aiCalls;
    },
    put(kind: string, value: { id: string }) {
      instance.db
        .prepare(
          "INSERT INTO objects(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
        )
        .run(kind, value.id, JSON.stringify(value));
    },
    objects<T>(kind: string): T[] {
      return (
        instance.db
          .prepare("SELECT data FROM objects WHERE kind=?")
          .all(kind) as unknown as { data: string }[]
      ).map((row) => JSON.parse(row.data));
    },
    close() {
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function staff(f: ReturnType<typeof fixture>) {
  const agent = request.agent(f.instance.app);
  assert.equal(
    (
      await agent
        .post("/api/staff/sessions")
        .send({ username: "demo", password: "LinliDemo-2026!" })
    ).status,
    200,
  );
  return agent;
}
function ticket(overrides: Partial<Ticket> = {}) {
  return {
    id: randomUUID(),
    number: "MANUAL-SECRET-NUMBER",
    siteId: "demo",
    siteName: "演示空间",
    locationId: "demo-entrance",
    locationName: "一号楼入口",
    category: "lighting" as const,
    description: "private original resident description",
    submissionId: randomUUID(),
    status: "pending" as const,
    assigneeId: null,
    assigneeName: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    returnStatus: null,
    facts: [],
    attachments: [],
    events: [],
    currentReceipt: null,
    receiptDraft: null,
    needsReview: false,
    stopReason: null,
    inputVersion: 1,
    ownerId: "private-resident-owner",
    draftId: randomUUID(),
    attachmentIds: [],
    effectiveFactIds: [],
    ...overrides,
  };
}

test("analytics, export and example loading require staff authentication", async () => {
  const f = fixture();
  try {
    const agent = request(f.instance.app);
    assert.equal((await agent.get("/api/staff/analytics")).status, 401);
    assert.equal((await agent.get("/api/staff/analytics/export")).status, 401);
    assert.equal(
      (await agent.post("/api/staff/demo-examples").send({ confirmed: true }))
        .status,
      401,
    );
    const resident = request.agent(f.instance.app);
    assert.equal(
      (await resident.post("/api/sessions/anonymous").send({ siteId: "demo" }))
        .status,
      200,
    );
    assert.equal((await resident.get("/api/staff/analytics")).status, 401);
  } finally {
    f.close();
  }
});

test("pilot staff cannot create examples", async () => {
  const f = fixture(false);
  try {
    const agent = await staff(f);
    const result = await agent
      .post("/api/staff/demo-examples")
      .send({ confirmed: true });
    assert.equal(result.status, 403);
    assert.equal(f.objects("ticket").length, 0);
  } finally {
    f.close();
  }
});

test("empty analytics preserves all dimensions and fourteen zero-filled China dates", async () => {
  const f = fixture();
  try {
    const result = await (await staff(f)).get("/api/staff/analytics");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.filters, DEFAULT_TICKET_FILTERS);
    assert.deepEqual(result.body.totals, {
      total: 0,
      active: 0,
      attention: 0,
      closed: 0,
      withdrawn: 0,
      examples: 0,
    });
    assert.equal(result.body.byStatus.length, 6);
    assert.equal(result.body.byCategory.length, 4);
    assert.equal(result.body.byLocation.length, 4);
    assert.equal(result.body.daily.length, 14);
    assert.ok(
      result.body.daily.every((day: { count: number }) => day.count === 0),
    );
    assert.equal(
      result.body.daily.at(-1).date,
      chinaDateKey(result.body.generatedAt),
    );
    assert.ok(Number.isFinite(Date.parse(result.body.generatedAt)));
  } finally {
    f.close();
  }
});

test("examples are explicit, idempotent, transactional fixtures and preserve manual data", async () => {
  const f = fixture();
  try {
    const manual = ticket();
    f.put("ticket", manual);
    const agent = await staff(f);
    const beforeCredentials = f.instance.db
      .prepare("SELECT count(*) AS n FROM credentials")
      .get()!.n;
    const first = await agent
      .post("/api/staff/demo-examples")
      .send({ confirmed: true });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { created: 12, existing: 0 });
    const [second, third] = await Promise.all(
      [1, 2].map(() =>
        agent.post("/api/staff/demo-examples").send({ confirmed: true }),
      ),
    );
    assert.deepEqual(second.body, { created: 0, existing: 12 });
    assert.deepEqual(third.body, { created: 0, existing: 12 });
    const all = f.objects<ReturnType<typeof ticket>>("ticket");
    assert.equal(all.length, 13);
    assert.deepEqual(
      all.find((t) => t.id === manual.id),
      manual,
    );
    assert.equal(
      f.objects<{ siteId: string }>("demo_fixture")[0]?.siteId,
      "demo",
    );
    for (const sample of all.filter((t) => t.isExample)) {
      assert.match(sample.description, /演示样例/);
      assert.deepEqual(sample.attachmentIds, []);
      assert.deepEqual(sample.facts, []);
      assert.deepEqual(sample.effectiveFactIds, []);
      assert.equal(sample.receiptDraft, null);
      if (sample.currentReceipt) {
        assert.match(sample.currentReceipt.description, /演示样例/);
        assert.deepEqual(sample.currentReceipt.attachments, []);
        assert.equal(sample.currentReceipt.coverage, null);
      }
    }
    assert.equal(
      f.instance.db.prepare("SELECT count(*) AS n FROM credentials").get()!.n,
      beforeCredentials,
    );
    assert.equal(f.objects("ai_run").length, 0);
    assert.equal(f.aiCalls, 0);
    const lost = all.find((t) => t.isExample)!;
    f.instance.db
      .prepare("DELETE FROM objects WHERE kind='ticket' AND id=?")
      .run(lost.id);
    assert.deepEqual(
      (await agent.post("/api/staff/demo-examples").send({ confirmed: true }))
        .body,
      { created: 0, existing: 11 },
    );
  } finally {
    f.close();
  }
});

test("example load rolls all fixture rows back when an audit insert fails", async () => {
  const f = fixture();
  try {
    const agent = await staff(f);
    f.instance.db.exec(
      "CREATE TRIGGER reject_example_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'fixture rollback test'); END;",
    );
    assert.equal(
      (await agent.post("/api/staff/demo-examples").send({ confirmed: true }))
        .status,
      500,
    );
    assert.equal(f.objects("ticket").length, 0);
    assert.equal(f.objects("demo_fixture").length, 0);
    f.instance.db.exec("DROP TRIGGER reject_example_audit");
    assert.deepEqual(
      (await agent.post("/api/staff/demo-examples").send({ confirmed: true }))
        .body,
      { created: 12, existing: 0 },
    );
  } finally {
    f.close();
  }
});

test("statistics cover every status and category, sources and site isolation", async () => {
  const f = fixture();
  try {
    f.put("ticket", ticket());
    f.put(
      "ticket",
      ticket({
        siteId: "pilot",
        locationId: "pilot-entrance",
        description: "pilot-private-description",
      }),
    );
    const agent = await staff(f);
    await agent.post("/api/staff/demo-examples").send({ confirmed: true });
    const result = (
      await agent.get("/api/staff/analytics").query({ source: "example" })
    ).body;
    assert.deepEqual(result.totals, {
      total: 12,
      active: 8,
      attention: 4,
      closed: 2,
      withdrawn: 2,
      examples: 12,
    });
    assert.ok(
      result.byStatus.every((row: { count: number }) => row.count === 2),
    );
    assert.ok(
      result.byCategory.every((row: { count: number }) => row.count === 3),
    );
    assert.ok(
      result.byLocation.every((row: { count: number }) => row.count === 3),
    );
    assert.equal(
      (await agent.get("/api/staff/analytics")).body.totals.total,
      13,
    );
    assert.equal(
      (await agent.get("/api/staff/analytics").query({ source: "manual" })).body
        .totals.total,
      1,
    );
    assert.equal(
      (
        await agent
          .get("/api/staff/analytics")
          .query({ source: "example", status: "active", assignee: "mine" })
      ).body.totals.total,
      6,
    );
    assert.equal(
      (
        await agent.get("/api/staff/analytics").query({
          source: "example",
          category: "cleaning",
          locationId: "demo-garden",
        })
      ).body.totals.total,
      3,
    );
    assert.equal(
      (
        await agent
          .get("/api/staff/analytics")
          .query({ query: "pilot-private-description" })
      ).body.totals.total,
      0,
    );
    const csv = await agent
      .get("/api/staff/analytics/export")
      .query({ query: "pilot-private-description" });
    assert.equal(csv.status, 200);
    assert.doesNotMatch(csv.text, /pilot-private-description|pilot-entrance/);
    assert.match(csv.text, /总量,.*0/);
  } finally {
    f.close();
  }
});

test("daily statistics use Beijing midnight and keep exactly fourteen consecutive days", async (t) => {
  const clock = Date.parse(`${chinaDateKey(Date.now())}T12:00:00+08:00`);
  t.mock.method(Date, "now", () => clock);
  const f = fixture();
  try {
    const todayStart = Date.parse(`${chinaDateKey(clock)}T00:00:00+08:00`);
    const times = [
      todayStart,
      todayStart - 1,
      todayStart - 13 * 86400000,
      todayStart - 13 * 86400000 - 1,
    ];
    for (const time of times)
      f.put("ticket", ticket({ createdAt: new Date(time).toISOString() }));
    const agent = await staff(f);
    const summary = (await agent.get("/api/staff/analytics")).body;
    assert.equal(summary.daily.length, 14);
    assert.deepEqual(
      summary.daily.map((day: { date: string }) => day.date),
      Array.from({ length: 14 }, (_, i) =>
        chinaDateKey(todayStart - (13 - i) * 86400000),
      ),
    );
    assert.equal(summary.daily[0].count, 1);
    assert.equal(summary.daily[12].count, 1);
    assert.equal(summary.daily[13].count, 1);
    assert.equal(
      summary.daily.reduce(
        (sum: number, day: { count: number }) => sum + day.count,
        0,
      ),
      3,
    );
    assert.equal(
      (await agent.get("/api/staff/analytics").query({ period: "7" })).body
        .totals.total,
      2,
    );
  } finally {
    f.close();
  }
});

test("analytics validates every query enum, length and repeated or unknown keys", async () => {
  const f = fixture();
  try {
    const agent = await staff(f);
    for (const query of [
      { status: "broken" },
      { category: "secret" },
      { assignee: "any" },
      { source: "bad" },
      { period: "14" },
      { sort: "descending" },
      { query: "a".repeat(201) },
      { locationId: "a".repeat(101) },
      { status: ["all", "pending"] },
      { unknown: "value" },
    ]) {
      assert.equal(
        (await agent.get("/api/staff/analytics").query(query)).status,
        422,
        JSON.stringify(query),
      );
      assert.equal(
        (await agent.get("/api/staff/analytics/export").query(query)).status,
        422,
        JSON.stringify(query),
      );
    }
    for (const body of [
      {},
      { confirmed: false },
      { confirmed: true, extra: "bad" },
    ])
      assert.equal(
        (await agent.post("/api/staff/demo-examples").send(body)).status,
        422,
      );
  } finally {
    f.close();
  }
});

test("CSV includes only aggregate dimensions and redacts all ticket and query free text", async () => {
  const f = fixture();
  try {
    const manual = ticket();
    f.put("ticket", manual);
    const agent = await staff(f);
    const response = await agent
      .get("/api/staff/analytics/export")
      .query({ query: "private original" });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /text\/csv.*charset=utf-8/i);
    assert.match(
      response.headers["content-disposition"],
      /attachment;.*linli-summary.csv/,
    );
    assert.equal(response.headers["cache-control"], "no-store");
    for (const secret of [
      manual.id,
      manual.number,
      manual.description,
      manual.ownerId,
      manual.submissionId,
      "private original",
    ])
      assert.ok(!response.text.includes(secret), secret);
    assert.match(response.text, /公共照明/);
    assert.match(response.text, /一号楼入口/);
    assert.match(response.text, /总量,.*1/);
    assert.equal(f.aiCalls, 0);
  } finally {
    f.close();
  }
});

test("all sample write paths reject changes and AI calls; unrelated residents cannot read", async () => {
  const f = fixture();
  try {
    const agent = await staff(f);
    await agent.post("/api/staff/demo-examples").send({ confirmed: true });
    const samples = f.objects<ReturnType<typeof ticket>>("ticket");
    const pending = samples.find((t) => t.status === "pending")!;
    const processing = samples.find((t) => t.status === "processing")!;
    assert.ok(pending && processing);
    const before = JSON.stringify(samples);
    for (const [sample, action] of [
      [pending, "claim"],
      [processing, "progress"],
      [processing, "request_info"],
      [processing, "return"],
      [processing, "receipt"],
    ] as const) {
      const response = await agent
        .post(`/api/tickets/${sample.id}/events`)
        .send({
          action,
          version: 1,
          idempotencyKey: randomUUID(),
          reason: "test",
        });
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "EXAMPLE_READ_ONLY");
    }
    const draft = await agent
      .put(`/api/tickets/${processing.id}/receipt-draft`)
      .send({
        version: 1,
        items: [],
        description: "test receipt",
        attachmentIds: [randomUUID()],
      });
    assert.equal(draft.status, 409);
    assert.equal(draft.body.error.code, "EXAMPLE_READ_ONLY");
    const check = await agent
      .post(`/api/tickets/${processing.id}/receipt-draft/check`)
      .send({ version: 1, draftVersion: 1, scopeVersion: 1 });
    assert.equal(check.status, 409);
    assert.equal(check.body.error.code, "EXAMPLE_READ_ONLY");
    const upload = await agent
      .post("/api/attachments")
      .field("ticketId", processing.id)
      .field("purpose", "receipt")
      .attach("file", Buffer.from("fake image"), "test.png");
    assert.equal(upload.status, 409);
    assert.equal(upload.body.error.code, "EXAMPLE_READ_ONLY");
    const resident = request.agent(f.instance.app);
    await resident
      .post("/api/auth/register")
      .send({
        siteId: "demo",
        username: "example_viewer",
        name: "居民",
        password: "ResidentPassword-2026!",
      });
    assert.equal(
      (await resident.get(`/api/tickets/${pending.id}`)).status,
      403,
    );
    assert.equal(JSON.stringify(f.objects("ticket")), before);
    assert.equal(f.objects("attachment").length, 0);
    assert.equal(f.objects("task").length, 0);
    assert.equal(f.aiCalls, 0);
  } finally {
    f.close();
  }
});

test("CSV cells escape quotes, delimiters and line breaks and neutralize spreadsheet formulas", async () => {
  const { csvCell, Operations } = await import("../server/operations/index.js");
  assert.equal(csvCell('plain,"quoted"'), '"plain,""quoted"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("安全中文"), "安全中文");
  assert.equal(csvCell(12), "12");
  for (const formula of [
    "=1+1",
    "+SUM(1,2)",
    "-1+2",
    "@SUM(A1)",
    "  =1",
    "\t=1",
    "\r=1",
    "\n=1",
    "＝1+1",
  ]) {
    const escaped = csvCell(formula);
    assert.ok(
      escaped.startsWith("'") || escaped.startsWith("\"'"),
      JSON.stringify({ formula, escaped }),
    );
  }
  const f = fixture();
  try {
    const agent = await staff(f);
    const summary = (await agent.get("/api/staff/analytics")).body;
    summary.byLocation[0].label =
      '=HYPERLINK("https://example.invalid","formula")';
    const csv = Operations.prototype.csv(summary);
    assert.ok(csv.includes(csvCell(summary.byLocation[0].label)));
    assert.ok(!csv.includes(',"=HYPERLINK'));
  } finally {
    f.close();
  }
});

test("read-only samples are rejected before disabled checks and body validation", async () => {
  const f = fixture();
  f.config.receiptCheckEnabled = false;
  try {
    const agent = await staff(f);
    await agent.post("/api/staff/demo-examples").send({ confirmed: true });
    const sample = f.objects<ReturnType<typeof ticket>>("ticket")[0]!;
    for (const endpoint of ["events", "receipt-draft/check"]) {
      const result = await agent
        .post(`/api/tickets/${sample.id}/${endpoint}`)
        .send({});
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, "EXAMPLE_READ_ONLY");
    }
    const result = await agent
      .put(`/api/tickets/${sample.id}/receipt-draft`)
      .send({});
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "EXAMPLE_READ_ONLY");
  } finally {
    f.close();
  }
});
