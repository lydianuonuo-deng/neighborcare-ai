import test from "node:test";
import assert from "node:assert/strict";
import type { Draft, Task } from "../shared/types";
import { refreshAfterClarification, receiptTextSegments } from "./workflows";

const draft = {
  id: "draft-1",
  version: 4,
  description: "灯晚上不亮。\n补充：二号楼一层。",
  category: "lighting",
  locationId: "corridor",
  analysis: null,
  question: null,
} as Draft;
const task = {
  id: "task-1",
  purpose: "analysis",
  state: "queued",
  createdAt: new Date().toISOString(),
} as Task;

test("a consented valid supplement analyzes its new version and returns refreshed facts", async () => {
  const calls: unknown[] = [];
  const refreshed = {
    ...draft,
    analysis: {
      category: "lighting",
      facts: [
        {
          id: "fact-new",
          text: "灯夜间不亮。",
          origin: "reported",
          evidenceRefs: ["description"],
          needsConfirmation: false,
        },
      ],
      gap: null,
      needsReview: false,
    },
  } as Draft;
  const result = await refreshAfterClarification(
    draft,
    "text",
    { enabled: true, consent: true },
    {
      analyze: async (id, version) => {
        calls.push(["analyze", id, version]);
        return task;
      },
      wait: async (value) => {
        calls.push(["wait", value.id]);
        return { ...value, state: "succeeded" };
      },
      draft: async (id) => {
        calls.push(["draft", id]);
        return refreshed;
      },
    },
  );
  assert.deepEqual(calls, [
    ["analyze", "draft-1", 4],
    ["wait", "task-1"],
    ["draft", "draft-1"],
  ]);
  assert.equal(result.analysis?.facts[0].id, "fact-new");
});

test("photo supplements also reanalyze, while skip, unknown, disabled AI, and missing consent make no calls", async () => {
  let calls = 0;
  const services = {
    analyze: async () => {
      calls++;
      return task;
    },
    wait: async (value: Task) => value,
    draft: async () => draft,
  };
  await refreshAfterClarification(
    draft,
    "photo",
    { enabled: true, consent: true },
    services,
  );
  assert.equal(calls, 1);
  for (const kind of ["skip", "not_sure"] as const)
    assert.equal(
      await refreshAfterClarification(
        draft,
        kind,
        { enabled: true, consent: true },
        services,
      ),
      draft,
    );
  assert.equal(
    await refreshAfterClarification(
      draft,
      "text",
      { enabled: false, consent: true },
      services,
    ),
    draft,
  );
  assert.equal(
    await refreshAfterClarification(
      draft,
      "text",
      { enabled: true, consent: false },
      services,
    ),
    draft,
  );
  assert.equal(calls, 1);
});

test("analysis failure never fetches or substitutes a successful result", async () => {
  let fetched = false;
  await assert.rejects(
    refreshAfterClarification(
      draft,
      "text",
      { enabled: true, consent: true },
      {
        analyze: async () => task,
        wait: async () => {
          throw new Error("provider unavailable");
        },
        draft: async () => {
          fetched = true;
          return draft;
        },
      },
    ),
    /provider unavailable/,
  );
  assert.equal(fetched, false);
  assert.equal(draft.description, "灯晚上不亮。\n补充：二号楼一层。");
});

test("receipt preview keeps backend segment IDs across whitespace-only lines", () => {
  assert.deepEqual(
    receiptTextSegments({ description: "已更换灯泡。\n   \n夜间效果待确认。" }),
    [
      { id: "s1", text: "已更换灯泡。" },
      { id: "s3", text: "夜间效果待确认。" },
    ],
  );
  const segments = [{ id: "server-id", text: "服务端固定的原句。" }];
  assert.equal(
    receiptTextSegments({ description: "其他文字", segments }),
    segments,
  );
});
