import test from "node:test";
import assert from "node:assert/strict";
import { destinationAfterLogin } from "./auth-navigation.js";
import {
  createDraftStorage,
  migrateGuestDraft,
  draftKeys,
} from "./draft-storage.js";

test("登录回跳只允许本站对应角色页面，拒绝外站与编码绕过", () => {
  assert.equal(
    destinationAfterLogin("resident", "/tickets/abc?submitted=1"),
    "/tickets/abc?submitted=1",
  );
  assert.equal(
    destinationAfterLogin("staff", "/staff/analytics"),
    "/staff/analytics",
  );
  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "/login",
    "/register",
    "/staff/users",
  ])
    assert.equal(destinationAfterLogin("resident", path), "/");
  assert.equal(destinationAfterLogin("staff", "/staff/users"), "/staff");
  assert.equal(destinationAfterLogin("admin", "/staff/users"), "/staff/users");
});

test("旧游客草稿仅迁入明确游客身份，其他账号恢复键相互隔离", () => {
  const values = new Map<string, string>([
    ["linli.report-draft.v1", '{"fields":{"description":"私密草稿"}}'],
    ["linli.pending-submit", '{"idempotencyKey":"secret"}'],
  ]);
  const storage = createDraftStorage(() => ({
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  }));
  migrateGuestDraft(storage, null);
  assert.ok(storage.getItem("linli.report-draft.v1"));
  migrateGuestDraft(storage, "guest-a");
  assert.match(storage.getItem(draftKeys("guest-a").cache)!, /私密草稿/);
  assert.equal(storage.getItem(draftKeys("account-b").cache), null);
  assert.equal(storage.getItem(draftKeys("account-b").pending), null);
  assert.equal(storage.getItem("linli.report-draft.v1"), null);
});
