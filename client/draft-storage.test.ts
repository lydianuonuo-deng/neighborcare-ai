import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStorage, readCachedJson } from "./draft-storage";

function stored(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

test("available browser storage restores and clears draft recovery keys", () => {
  const browser = stored({ draft: '{"draftId":"existing"}' });
  const cache = createDraftStorage(() => browser);
  assert.deepEqual(readCachedJson(cache, "draft"), { draftId: "existing" });
  cache.setItem("pending", "same-key");
  assert.equal(browser.getItem("pending"), "same-key");
  cache.removeItem("draft");
  assert.equal(cache.getItem("draft"), null);
  assert.equal(cache.persistent, true);
});

test("denied storage access retains same-page draft and submission keys without throwing", () => {
  const cache = createDraftStorage(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  assert.equal(cache.getItem("draft"), null);
  cache.setItem("draft", "draft-1");
  cache.setItem("pending", "original-idempotency-key");
  assert.equal(cache.getItem("pending"), "original-idempotency-key");
  assert.equal(cache.getItem("draft"), "draft-1");
  cache.removeItem("draft");
  assert.equal(cache.getItem("draft"), null);
  assert.equal(cache.persistent, false);
});

test("full storage cannot replace a new in-memory draft with stale persisted content", () => {
  const browser = stored({ draft: "old" });
  const cache = createDraftStorage(() => browser);
  assert.equal(cache.getItem("draft"), "old");
  browser.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  cache.setItem("draft", "new unsaved text");
  assert.equal(cache.getItem("draft"), "new unsaved text");
  assert.equal(cache.persistent, false);
});

test("corrupt cached JSON is discarded without blocking later submissions", () => {
  const browser = stored();
  const cache = createDraftStorage(() => browser);
  cache.setItem("pending", "broken JSON");
  assert.equal(readCachedJson(cache, "pending"), null);
  assert.equal(cache.getItem("pending"), null);
});
