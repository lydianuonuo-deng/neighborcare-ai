import test from "node:test";
import assert from "node:assert/strict";
import type { Ticket } from "../shared/types.js";
import { filterTickets, chinaDateKey } from "../shared/operations.js";
const base = {
  number: "LL-ABC",
  description: "楼道 LED 灯不亮",
  locationName: "二号楼",
  category: "lighting",
  status: "pending",
  locationId: "corridor",
  assigneeId: null,
  createdAt: "2026-10-15T01:00:00Z",
  updatedAt: "2026-10-15T01:00:00Z",
} as Ticket;
const item = (id: string, patch: Partial<Ticket> = {}) => ({
  ...base,
  id,
  ...patch,
});
test("combined filters match all trimmed case-insensitive keywords and keep input order unchanged", () => {
  const tickets = [
    item("a"),
    item("b", { category: "cleaning" }),
    item("c", { description: "花园灯不亮" }),
  ];
  assert.deepEqual(
    filterTickets(tickets, {
      query: "  二号楼 led  ",
      category: "lighting",
    }).map((t) => t.id),
    ["a"],
  );
  assert.deepEqual(
    tickets.map((t) => t.id),
    ["a", "b", "c"],
  );
});
test("assignment, attention and source filters compose without expanding ownership", () => {
  const tickets = [
    item("a", { status: "needs_info", assigneeId: "s1" }),
    item("b", {
      status: "awaiting_confirmation",
      assigneeId: "s1",
      isExample: true,
    }),
    item("c", { status: "closed", assigneeId: "s2" }),
  ];
  assert.deepEqual(
    filterTickets(
      tickets,
      { status: "attention", assignee: "mine", source: "manual" },
      "s1",
    ).map((t) => t.id),
    ["a"],
  );
  assert.equal(filterTickets(tickets, { assignee: "mine" }).length, 0);
  assert.deepEqual(
    filterTickets(tickets, { status: "ended" }).map((t) => t.id),
    ["c"],
  );
});
test("seven-day window uses Beijing calendar days and excludes future records", () => {
  const clock = Date.parse("2026-10-15T01:00:00Z");
  const tickets = [
    item("edge", { createdAt: "2026-10-08T16:00:00Z" }),
    item("old", { createdAt: "2026-10-08T15:59:59Z" }),
    item("future", { createdAt: "2026-10-16T01:00:00Z" }),
  ];
  assert.deepEqual(
    filterTickets(tickets, { period: "7" }, undefined, clock).map((t) => t.id),
    ["edge"],
  );
  assert.equal(chinaDateKey("2026-10-14T17:00:00Z"), "2026-10-15");
});
test("sort and location filters use the chosen time field without mutating stored records", () => {
  const tickets = [
    item("a", {
      updatedAt: "2026-10-15T03:00:00Z",
      createdAt: "2026-10-14T01:00:00Z",
    }),
    item("b", { createdAt: "2026-10-15T01:00:00Z" }),
    item("c", { locationId: "garden" }),
  ];
  assert.deepEqual(
    filterTickets(tickets, { locationId: "corridor", sort: "newest" }).map(
      (t) => t.id,
    ),
    ["b", "a"],
  );
  assert.deepEqual(
    filterTickets(tickets, { locationId: "corridor", sort: "oldest" }).map(
      (t) => t.id,
    ),
    ["a", "b"],
  );
  assert.deepEqual(
    filterTickets(tickets, { locationId: "corridor" }).map((t) => t.id),
    ["a", "b"],
  );
});
