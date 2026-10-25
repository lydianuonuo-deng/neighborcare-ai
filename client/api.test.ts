import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "./api";

test("request timeout covers a stalled response body after headers arrive", async () => {
  const original = globalThis.fetch;
  let headersReceived = false;
  let bodyAborted = false;
  let finishBody: (() => void) | undefined;
  // Deliver headers deterministically so a cold HTTP client cannot consume the
  // entire deadline before the stalled-body behavior is exercised.
  globalThis.fetch = async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        const abort = () => {
          bodyAborted = true;
          controller.error(new DOMException("Aborted", "AbortError"));
        };
        init?.signal?.addEventListener("abort", abort, { once: true });
        finishBody = () => {
          init?.signal?.removeEventListener("abort", abort);
          if (!bodyAborted) {
            controller.enqueue(new TextEncoder().encode('"late"}'));
            controller.close();
          }
        };
      },
    });
    headersReceived = true;
    return new Response(body, {
      headers: { "Content-Type": "application/json" },
    });
  };
  const fallback = setTimeout(() => finishBody?.(), 1000);
  try {
    await assert.rejects(
      api.task("slow-body", 120),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "NETWORK" &&
        /超时/.test(error.message),
    );
    assert.equal(
      headersReceived,
      true,
      "the timeout must occur while reading the body, after headers arrived",
    );
    assert.equal(bodyAborted, true);
  } finally {
    clearTimeout(fallback);
    finishBody?.();
    globalThis.fetch = original;
  }
});

test("a successful response with unreadable or null JSON fails with a useful message", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of ["<html>upstream unavailable</html>", "null"]) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      await assert.rejects(
        api.bootstrap(),
        (error: unknown) =>
          error instanceof ApiError && error.code === "INVALID_RESPONSE",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("structured API errors and non-JSON error responses retain friendly failure handling", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          error: {
            code: "STAFF_LOGIN_REQUIRED",
            message: "请先登录工作人员账户。",
          },
        },
        { status: 401 },
      );
    await assert.rejects(
      api.tickets(true),
      (error: unknown) =>
        error instanceof ApiError && error.code === "STAFF_LOGIN_REQUIRED",
    );
    globalThis.fetch = async () =>
      new Response("upstream unavailable", { status: 503 });
    await assert.rejects(
      api.bootstrap(),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 503 &&
        error.code === "REQUEST_FAILED",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("statistics downloads keep binary content and reject expired staff sessions", async () => {
  const { DEFAULT_TICKET_FILTERS } = await import("../shared/operations");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("分组,数量\r\n状态,12", {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    const result = await api.exportAnalytics({ ...DEFAULT_TICKET_FILTERS });
    assert.equal(await result.text(), "分组,数量\r\n状态,12");
    globalThis.fetch = async () =>
      Response.json(
        { error: { code: "STAFF_LOGIN_REQUIRED", message: "请先登录。" } },
        { status: 401 },
      );
    await assert.rejects(
      api.exportAnalytics({ ...DEFAULT_TICKET_FILTERS }),
      (error) =>
        error instanceof ApiError && error.code === "STAFF_LOGIN_REQUIRED",
    );
  } finally {
    globalThis.fetch = original;
  }
});
