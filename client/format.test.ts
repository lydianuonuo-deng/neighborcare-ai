import test from "node:test";
import assert from "node:assert/strict";
import { date } from "./format";

test("display times consistently use Beijing time even if the device timezone is UTC", () => {
  const previous = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const value = date("2026-10-14T17:30:00Z");
    assert.match(value, /10\/15/);
    assert.match(value, /01:30/);
    assert.equal(date("2026-10-14T17:30:00Z", false), "10/15");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
