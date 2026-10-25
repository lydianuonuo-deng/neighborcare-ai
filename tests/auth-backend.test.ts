import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import request from "supertest";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import type { AiService } from "../shared/types.js";

const ai: AiService = {
  analyze: async () => {
    throw new Error("unused");
  },
  checkReceipt: async () => {
    throw new Error("unused");
  },
};
const password = "ResidentPassword-2026!";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "linli-auth-"));
  const config = loadConfig({
    DB_PATH: join(dir, "auth.sqlite"),
    UPLOAD_DIR: join(dir, "uploads"),
  });
  let instance = createApp({ config, ai });
  return {
    config,
    get instance() {
      return instance;
    },
    restart() {
      instance.close();
      instance = createApp({ config, ai });
    },
    close() {
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const signup = (
  agent: ReturnType<typeof request.agent>,
  username = `r_${randomUUID().slice(0, 8)}`,
  extra = {},
) =>
  agent
    .post("/api/auth/register")
    .send({ siteId: "demo", username, name: "陈居民", password, ...extra });
async function admin(f: ReturnType<typeof fixture>) {
  const agent = request.agent(f.instance.app);
  assert.equal(
    (
      await agent.post("/api/auth/login").send({
        siteId: "demo",
        username: "admin",
        password: "LinliAdmin-2026!",
      })
    ).status,
    200,
  );
  return agent;
}
function account(f: ReturnType<typeof fixture>, username: string): any {
  const row = f.instance.db
    .prepare(
      "SELECT data FROM objects WHERE kind='account' AND json_extract(data,'$.username')=?",
    )
    .get(username) as { data: string };
  return JSON.parse(row.data);
}

test("registration stores salted passwords, rotates cookies and preserves account login across restart", async () => {
  const f = fixture();
  try {
    const a = request.agent(f.instance.app),
      b = request.agent(f.instance.app);
    const result = await signup(a, "CaseUser");
    assert.equal(result.status, 201);
    assert.equal(result.body.user.role, "resident");
    assert.equal(result.body.user.username, "caseuser");
    assert.equal(JSON.stringify(result.body).includes("password"), false);
    assert.equal((await signup(b, "seconduser")).status, 201);
    const stored = account(f, "caseuser"),
      other = account(f, "seconduser");
    assert.ok(stored.passwordHash && stored.passwordSalt);
    assert.ok(Buffer.from(stored.passwordSalt, "hex").length >= 16);
    assert.ok(
      timingSafeEqual(
        Buffer.from(stored.passwordHash, "hex"),
        scryptSync(password, stored.passwordSalt, 64, {
          N: 16384,
          r: 8,
          p: 5,
          maxmem: 64 * 1024 * 1024,
        }),
      ),
    );
    assert.notEqual(stored.passwordSalt, other.passwordSalt);
    assert.notEqual(stored.passwordHash, other.passwordHash);
    assert.equal(JSON.stringify(stored).includes(password), false);
    assert.equal(
      (await a.get("/api/bootstrap")).body.user.id,
      result.body.user.id,
    );
    const cookie = result.headers["set-cookie"];
    f.restart();
    assert.equal(
      (
        await request(f.instance.app)
          .get("/api/me/tickets")
          .set("Cookie", cookie)
      ).status,
      200,
    );
    const login = await request(f.instance.app)
      .post("/api/auth/login")
      .send({ siteId: "demo", username: "CASEUSER", password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, result.body.user.id);
    assert.equal(
      (
        await request(f.instance.app)
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "caseuser", password: "wrong" })
      ).status,
      401,
    );
    const duplicate = await signup(request.agent(f.instance.app), "CASEUSER");
    assert.equal(duplicate.status, 409);
  } finally {
    f.close();
  }
});

test("public registration rejects privileged roles and all private routes require registered accounts", async () => {
  const f = fixture();
  try {
    const guest = request.agent(f.instance.app);
    assert.equal(
      (await guest.post("/api/sessions/anonymous").send({ siteId: "demo" }))
        .status,
      200,
    );
    const boot = (await guest.get("/api/bootstrap")).body;
    assert.equal(boot.user, null);
    assert.ok(boot.guestId);
    for (const path of [
      "/api/me/tickets",
      "/api/tickets/missing",
      "/api/drafts/missing",
      "/api/tasks/missing",
      "/api/attachments/missing",
      "/api/submissions/missing",
      "/api/admin/users",
    ])
      assert.equal((await guest.get(path)).status, 401, path);
    assert.equal((await guest.post("/api/drafts").send({})).status, 401);
    assert.equal((await guest.post("/api/attachments").send({})).status, 401);
    assert.equal(
      (await signup(guest, "badrole", { role: "admin" })).status,
      422,
    );
    assert.equal((await signup(guest, "resident1")).status, 201);
    assert.equal((await guest.get("/api/admin/users")).status, 403);
    assert.equal((await guest.get("/api/staff/tickets")).status, 403);
    const staff = request.agent(f.instance.app);
    assert.equal(
      (
        await staff
          .post("/api/staff/sessions")
          .send({ username: "demo", password: "LinliDemo-2026!" })
      ).status,
      200,
    );
    assert.equal((await staff.post("/api/drafts").send({})).status, 403);
    assert.equal((await staff.get("/api/admin/users")).status, 403);
  } finally {
    f.close();
  }
});

test("guest registration keeps legacy draft and ticket ownership, while login never merges identities", async () => {
  const f = fixture();
  try {
    const guest = request.agent(f.instance.app);
    const legacy = await guest
      .post("/api/sessions/anonymous")
      .send({ siteId: "demo" });
    const guestId = legacy.body.id;
    const draftId = randomUUID();
    const draft = {
      id: draftId,
      ownerId: guestId,
      siteId: "demo",
      version: 1,
      locationId: null,
      category: "unknown",
      description: "旧草稿",
      attachmentIds: [],
      attachments: [],
      analysis: null,
      question: null,
      clarificationCount: 0,
      semanticCount: 0,
      stopReason: null,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      descriptionSource: "resident",
      effectiveFactIds: [],
      answers: {},
      history: [],
    };
    f.instance.db
      .prepare("INSERT INTO objects(kind,id,data) VALUES(?,?,?)")
      .run("draft", draftId, JSON.stringify(draft));
    const ticketId = randomUUID();
    const ticket = {
      id: ticketId,
      siteId: "demo",
      siteName: "社区",
      ownerId: guestId,
      draftId,
      number: "LEGACY-1",
      version: 1,
      status: "pending",
      assigneeId: null,
      assigneeName: null,
      locationId: "demo-entrance",
      locationName: "入口",
      category: "lighting",
      description: "旧工单",
      submissionId: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      returnStatus: null,
      facts: [],
      attachments: [],
      events: [],
      attachmentIds: [],
      effectiveFactIds: [],
      currentReceipt: null,
      receiptDraft: null,
    };
    f.instance.db
      .prepare("INSERT INTO objects(kind,id,data) VALUES(?,?,?)")
      .run("ticket", ticketId, JSON.stringify(ticket));
    const registered = await signup(guest, "legacyowner");
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.id, guestId);
    assert.equal((await guest.get(`/api/drafts/${draftId}`)).status, 200);
    assert.equal(
      (
        await request(f.instance.app)
          .get(`/api/drafts/${draftId}`)
          .set("Cookie", legacy.headers["set-cookie"])
      ).status,
      401,
    );
    assert.equal((await guest.get(`/api/tickets/${ticketId}`)).status, 200);
    assert.equal(
      (await guest.get("/api/me/tickets")).body.tickets[0].id,
      ticketId,
    );
    const unchanged = f.instance.db
      .prepare("SELECT data FROM objects WHERE kind='ticket' AND id=?")
      .get(ticketId) as { data: string };
    assert.deepEqual(JSON.parse(unchanged.data), ticket);
    const other = request.agent(f.instance.app);
    const second = await signup(other, "differentowner");
    assert.equal(second.status, 201);
    assert.equal(
      (
        await guest
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "differentowner", password })
      ).status,
      200,
    );
    assert.equal((await guest.get(`/api/drafts/${draftId}`)).status, 403);
    assert.equal((await guest.get("/api/bootstrap")).body.guestId, null);
  } finally {
    f.close();
  }
});

test("admin manages only same-site staff and disabling revokes every old session", async () => {
  const f = fixture();
  try {
    const a = await admin(f);
    const created = await a.post("/api/admin/users").send({
      siteId: "demo",
      username: "worker",
      name: "维修员",
      password,
      role: "staff",
    });
    assert.equal(created.status, 201);
    assert.equal(
      (
        await a.post("/api/admin/users").send({
          siteId: "demo",
          username: "admin2",
          name: "管理员",
          password,
          role: "admin",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await a.post("/api/admin/users").send({
          siteId: "pilot",
          username: "pilotworker",
          name: "工作人员",
          password,
          role: "staff",
        })
      ).status,
      403,
    );
    const worker = request.agent(f.instance.app);
    assert.equal(
      (
        await worker
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "worker", password })
      ).status,
      200,
    );
    assert.equal(
      (
        await a
          .patch(`/api/admin/users/${created.body.user.id}`)
          .send({ status: "disabled" })
      ).status,
      200,
    );
    assert.equal((await worker.get("/api/staff/tickets")).status, 401);
    assert.equal(
      (
        await worker
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "worker", password })
      ).status,
      401,
    );
    const own = (await a.get("/api/bootstrap")).body.user;
    assert.equal(
      (await a.patch(`/api/admin/users/${own.id}`).send({ status: "disabled" }))
        .status,
      403,
    );
    assert.equal(
      (
        await a
          .patch(`/api/admin/users/${created.body.user.id}`)
          .send({ status: "active" })
      ).status,
      200,
    );
    assert.equal((await worker.get("/api/staff/tickets")).status, 401);
    const list = await a.get("/api/admin/users");
    assert.equal(list.status, 200);
    assert.ok(list.body.users.length >= 4);
    assert.equal(JSON.stringify(list.body).includes("password"), false);
  } finally {
    f.close();
  }
});

test("password change checks current password, invalidates all sessions and is not overwritten by seed on restart", async () => {
  const f = fixture();
  try {
    const a = await admin(f),
      second = await admin(f);
    assert.equal(
      (
        await a
          .patch("/api/auth/password")
          .send({ currentPassword: "wrong", newPassword: password })
      ).status,
      401,
    );
    assert.equal((await second.get("/api/admin/users")).status, 200);
    assert.equal(
      (
        await a
          .patch("/api/auth/password")
          .send({ currentPassword: "LinliAdmin-2026!", newPassword: password })
      ).status,
      204,
    );
    assert.equal((await second.get("/api/admin/users")).status, 401);
    assert.equal((await a.get("/api/admin/users")).status, 401);
    f.restart();
    assert.equal(
      (
        await request(f.instance.app)
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "admin", password })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(f.instance.app).post("/api/auth/login").send({
          siteId: "demo",
          username: "admin",
          password: "LinliAdmin-2026!",
        })
      ).status,
      401,
    );
  } finally {
    f.close();
  }
});

test("concurrent registration has one case-insensitive username winner and login clears other role cookie", async () => {
  const f = fixture();
  try {
    const results = await Promise.all(
      ["RaceUser", "raceuser", "RACEUSER"].map((name) =>
        signup(request.agent(f.instance.app), name),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    const agent = await admin(f);
    assert.equal(
      (
        await agent
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "raceuser", password })
      ).status,
      200,
    );
    const boot = (await agent.get("/api/bootstrap")).body;
    assert.equal(boot.staff, null);
    assert.equal(boot.user.role, "resident");
    assert.equal((await agent.get("/api/admin/users")).status, 403);
    assert.equal((await agent.delete("/api/auth/session")).status, 204);
    assert.equal((await agent.get("/api/bootstrap")).body.user, null);
  } finally {
    f.close();
  }
});

test("staff compatibility login uses persisted changed passwords and disabled accounts survive reseeding", async () => {
  const f = fixture();
  try {
    const worker = request.agent(f.instance.app),
      second = request.agent(f.instance.app);
    for (const agent of [worker, second])
      assert.equal(
        (
          await agent
            .post("/api/staff/sessions")
            .send({ username: "demo", password: "LinliDemo-2026!" })
        ).status,
        200,
      );
    const bootstrap = (await worker.get("/api/bootstrap")).body;
    assert.equal(bootstrap.staff.id, "demo-staff-1");
    assert.equal(bootstrap.staff.role, "staff");
    assert.equal(
      (
        await worker
          .patch("/api/auth/password")
          .send({ currentPassword: "LinliDemo-2026!", newPassword: password })
      ).status,
      204,
    );
    assert.equal((await second.get("/api/staff/tickets")).status, 401);
    f.restart();
    const afterRestart = request.agent(f.instance.app);
    assert.equal(
      (
        await afterRestart
          .post("/api/staff/sessions")
          .send({ username: "demo", password: "LinliDemo-2026!" })
      ).status,
      401,
    );
    assert.equal(
      (
        await afterRestart
          .post("/api/staff/sessions")
          .send({ username: "demo", password })
      ).status,
      200,
    );
    const a = await admin(f);
    assert.equal(
      (
        await a
          .patch("/api/admin/users/demo-staff-1")
          .send({ status: "disabled" })
      ).status,
      200,
    );
    f.restart();
    assert.equal(
      (
        await request(f.instance.app)
          .post("/api/staff/sessions")
          .send({ username: "demo", password })
      ).status,
      401,
    );
    assert.equal(account(f, "demo").status, "disabled");
  } finally {
    f.close();
  }
});

test("site checks apply to accounts, drafts and tickets, and admins cannot bypass the assigned worker", async () => {
  const f = fixture();
  try {
    const a = await admin(f),
      resident = request.agent(f.instance.app),
      worker = request.agent(f.instance.app);
    assert.equal((await signup(resident, "resource_owner")).status, 201);
    const draft = await resident.post("/api/drafts").send({
      locationId: "demo-entrance",
      category: "lighting",
      description: "楼道灯不亮",
    });
    assert.equal(draft.status, 201);
    const submission = await resident.post("/api/tickets").send({
      draftId: draft.body.id,
      version: 1,
      category: "lighting",
      description: "楼道灯不亮",
      locationId: "demo-entrance",
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    assert.equal(submission.status, 201);
    const ticket = submission.body.ticket;
    assert.equal(
      (
        await worker
          .post("/api/staff/sessions")
          .send({ username: "demo", password: "LinliDemo-2026!" })
      ).status,
      200,
    );
    const claimed = await worker.post(`/api/tickets/${ticket.id}/events`).send({
      action: "claim",
      version: ticket.version,
      idempotencyKey: randomUUID(),
    });
    assert.equal(claimed.status, 200);
    const bypass = await a.post(`/api/tickets/${ticket.id}/events`).send({
      action: "progress",
      version: claimed.body.ticket.version,
      reason: "管理员尝试代办",
      idempotencyKey: randomUUID(),
    });
    assert.equal(bypass.status, 403);
    assert.equal(bypass.body.error.code, "NOT_ASSIGNEE");
    assert.equal(
      (
        await a.post(`/api/tickets/${ticket.id}/events`).send({
          action: "withdraw",
          version: claimed.body.ticket.version,
          idempotencyKey: randomUUID(),
        })
      ).status,
      403,
    );
    const foreign = {
      ...account(f, "demo"),
      id: "pilot-worker",
      siteId: "pilot",
      username: "pilotworker",
      usernameNormalized: "pilotworker",
    };
    f.instance.db
      .prepare("INSERT INTO objects(kind,id,data) VALUES(?,?,?)")
      .run("account", foreign.id, JSON.stringify(foreign));
    assert.equal(
      (
        await a
          .patch(`/api/admin/users/${foreign.id}`)
          .send({ status: "disabled" })
      ).status,
      403,
    );
    assert.ok(
      (await a.get("/api/admin/users")).body.users.every(
        (u: { siteId: string }) => u.siteId === "demo",
      ),
    );
    const foreignDraft = {
      ...draft.body,
      id: randomUUID(),
      siteId: "pilot",
      ownerId: (await resident.get("/api/bootstrap")).body.user.id,
    };
    f.instance.db
      .prepare("INSERT INTO objects(kind,id,data) VALUES(?,?,?)")
      .run("draft", foreignDraft.id, JSON.stringify(foreignDraft));
    assert.equal(
      (await resident.get(`/api/drafts/${foreignDraft.id}`)).status,
      403,
    );
    const row = f.instance.db
      .prepare("SELECT data FROM objects WHERE kind='ticket' AND id=?")
      .get(ticket.id) as { data: string };
    const foreignTicket = {
      ...JSON.parse(row.data),
      id: randomUUID(),
      siteId: "pilot",
    };
    f.instance.db
      .prepare("INSERT INTO objects(kind,id,data) VALUES(?,?,?)")
      .run("ticket", foreignTicket.id, JSON.stringify(foreignTicket));
    for (const agent of [a, worker, resident])
      assert.equal(
        (await agent.get(`/api/tickets/${foreignTicket.id}`)).status,
        403,
      );
  } finally {
    f.close();
  }
});

test("validation, same-origin protection and authentication limits reject malformed or repeated attempts", async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.instance.app);
    for (const extra of [
      { password: "too_short" },
      { password: "x".repeat(129) },
      { username: "ab" },
      { username: "bad space" },
      { name: " " },
      { name: "x".repeat(41) },
      { siteId: "other" },
    ])
      assert.equal((await signup(agent, "validateuser", extra)).status, 422);
    assert.equal(
      (
        await agent
          .post("/api/auth/register")
          .set("Origin", "https://untrusted.invalid")
          .send({
            siteId: "demo",
            username: "validuser",
            name: "居民",
            password,
          })
      ).status,
      403,
    );
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await agent
            .post("/api/auth/login")
            .send({ siteId: "demo", username: "missinguser", password })
        ).status,
        401,
      );
    const blocked = await agent
      .post("/api/auth/login")
      .send({ siteId: "demo", username: "missinguser", password });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers["retry-after"]);
  } finally {
    f.close();
  }
});

test("pilot mode requires explicit administrator bootstrap credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "linli-auth-config-"));
  try {
    const env = {
      DB_PATH: join(dir, "auth.sqlite"),
      UPLOAD_DIR: join(dir, "uploads"),
      DEMO_MODE: "false",
      STAFF_PASSWORD: password,
    };
    assert.throws(() => loadConfig(env), /ADMIN_USERNAME and ADMIN_PASSWORD/);
    assert.throws(
      () => loadConfig({ ...env, ADMIN_USERNAME: "admin" }),
      /ADMIN_USERNAME and ADMIN_PASSWORD/,
    );
    const config = loadConfig({
      ...env,
      ADMIN_USERNAME: "pilotadmin",
      ADMIN_PASSWORD: password,
    });
    assert.equal(config.adminUsername, "pilotadmin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each request checks persisted session version and role, and login revokes the previous browser credential", async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.instance.app);
    const registered = await signup(agent, "sessioncheck");
    assert.equal(registered.status, 201);
    const previousCookie = registered.headers["set-cookie"];
    const login = await agent
      .post("/api/auth/login")
      .send({ siteId: "demo", username: "sessioncheck", password });
    assert.equal(login.status, 200);
    assert.equal(
      (
        await request(f.instance.app)
          .get("/api/me/tickets")
          .set("Cookie", previousCookie)
      ).status,
      401,
    );
    const persisted = account(f, "sessioncheck");
    const credentialsBefore = f.instance.db
      .prepare(
        "SELECT COUNT(*) AS n FROM credentials WHERE json_extract(data,'$.id')=?",
      )
      .get(persisted.id)!.n;
    assert.equal(credentialsBefore, 1);
    const changed = {
      ...persisted,
      sessionVersion: persisted.sessionVersion + 1,
    };
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind='account' AND id=?")
      .run(JSON.stringify(changed), persisted.id);
    assert.equal((await agent.get("/api/me/tickets")).status, 401);
    assert.equal(
      f.instance.db
        .prepare(
          "SELECT COUNT(*) AS n FROM credentials WHERE json_extract(data,'$.id')=?",
        )
        .get(persisted.id)!.n,
      1,
    );
    assert.equal(
      (
        await agent
          .post("/api/auth/login")
          .send({ siteId: "demo", username: "sessioncheck", password })
      ).status,
      200,
    );
    f.instance.db
      .prepare("UPDATE objects SET data=? WHERE kind='account' AND id=?")
      .run(JSON.stringify({ ...changed, role: "staff" }), persisted.id);
    assert.equal((await agent.get("/api/me/tickets")).status, 401);
    assert.equal((await agent.get("/api/staff/tickets")).status, 401);
  } finally {
    f.close();
  }
});

test("successful shared-network logins do not exhaust the failure budget and stale form identity cannot create a draft", async () => {
  const f = fixture();
  try {
    const a = request.agent(f.instance.app);
    const original = await signup(a, "original_identity");
    assert.equal(original.status, 201);
    for (let i = 0; i < 12; i++) {
      const result = await a
        .post("/api/auth/login")
        .send({ siteId: "demo", username: "original_identity", password });
      assert.equal(result.status, 200);
    }
    const b = await signup(a, "switched_identity");
    assert.equal(b.status, 201);
    const stale = await a
      .post("/api/drafts")
      .set("X-Account-Id", original.body.user.id)
      .send({ siteId: "demo" });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.error.code, "ACCOUNT_CHANGED");
    assert.equal(
      (
        await a
          .post("/api/drafts")
          .set("X-Account-Id", b.body.user.id)
          .send({ siteId: "demo" })
      ).status,
      201,
    );
  } finally {
    f.close();
  }
});

test("bootstrap usernames respect login bounds and demo second staff remains distinct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linli-auth-seed-"));
  try {
    assert.throws(
      () => loadConfig({ STAFF_USERNAME: "bad name" }),
      /STAFF_USERNAME/,
    );
    assert.throws(
      () => loadConfig({ STAFF_PASSWORD: "x".repeat(129) }),
      /STAFF_PASSWORD/,
    );
    const config = loadConfig({
      DB_PATH: join(dir, "auth.sqlite"),
      UPLOAD_DIR: join(dir, "uploads"),
      STAFF_USERNAME: "a".repeat(32),
      ADMIN_USERNAME: "a".repeat(31) + "2",
    });
    const instance = createApp({ config, ai });
    try {
      const rows = instance.db
        .prepare("SELECT data FROM objects WHERE kind='account'")
        .all() as { data: string }[];
      const accounts = rows.map((row) => JSON.parse(row.data));
      assert.equal(accounts.length, 4);
      assert.equal(new Set(accounts.map((a) => a.username)).size, 4);
      assert.ok(accounts.every((a) => a.username.length <= 32));
    } finally {
      instance.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration IP budget survives authenticated identity rotation", async () => {
  const f = fixture();
  try {
    const a = request.agent(f.instance.app),
      b = request.agent(f.instance.app);
    assert.equal((await signup(a, "limit_a")).status, 201);
    assert.equal((await signup(b, "limit_b")).status, 201);
    for (let i = 0; i < 28; i++)
      assert.equal((await signup(i % 2 ? a : b, "!")).status, 422);
    const blocked = await signup(a, "another_account");
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers["retry-after"]);
  } finally {
    f.close();
  }
});

test("built-in resident account can log in but cannot access staff or admin APIs", async () => {
  const f = fixture();
  try {
    const visitor = request.agent(f.instance.app);
    const login = await visitor.post("/api/auth/login").send({
      siteId: "demo",
      username: "resident",
      password: "LinliResident-2026!",
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, "resident");
    assert.equal((await visitor.get("/api/staff/tickets")).status, 403);
    assert.equal((await visitor.get("/api/admin/users")).status, 403);
    assert.equal((await visitor.get("/api/me/tickets")).status, 200);
    f.restart();
    const currentCookie = (login.headers["set-cookie"] as unknown as string[])
      .filter((value) => value.startsWith("nr_resident="))
      .at(-1)!
      .split(";")[0];
    const restored = await request(f.instance.app)
      .get("/api/bootstrap")
      .set("Cookie", currentCookie);
    assert.equal(restored.body.user.role, "resident");
  } finally {
    f.close();
  }
});

test("pilot mode never seeds the public resident demo account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "linli-pilot-no-demo-"));
  const config = loadConfig({
    DEMO_MODE: "false",
    STAFF_USERNAME: "pilotstaff",
    STAFF_PASSWORD: password,
    ADMIN_USERNAME: "pilotadmin",
    ADMIN_PASSWORD: password,
    DB_PATH: join(dir, "test.sqlite"),
    UPLOAD_DIR: join(dir, "uploads"),
  });
  const instance = createApp({ config, ai });
  try {
    const visitor = request.agent(instance.app);
    assert.equal((await visitor.get("/api/bootstrap")).body.demoMode, false);
    assert.equal(
      (
        await visitor.post("/api/auth/login").send({
          siteId: "pilot",
          username: "resident",
          password: "LinliResident-2026!",
        })
      ).status,
      401,
    );
    assert.equal(
      instance.db
        .prepare("SELECT id FROM objects WHERE kind='account' AND id=?")
        .get("demo-resident-1"),
      undefined,
    );
  } finally {
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
