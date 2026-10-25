import assert from "node:assert/strict";
import test from "node:test";
import { detectEmergency } from "../server/ai/emergency.js";

test("emergency text detection separates active danger from negation and ordinary lighting", () => {
  assert.equal(detectEmergency("楼道有浓烟，还看到火苗"), true);
  assert.equal(detectEmergency("闻到很重的燃气味"), true);
  assert.equal(
    detectEmergency("没有着火，也没有闻到燃气味，只是灯不亮"),
    false,
  );
  assert.equal(detectEmergency("未发现漏气，楼道灯晚上不亮"), false);
  assert.equal(detectEmergency("不是没有漏气，正在持续漏气"), true);
  assert.equal(detectEmergency("没有明火，但是电线正在冒烟"), true);
  assert.equal(detectEmergency("请不要靠近火苗"), true);
  assert.equal(detectEmergency("楼道灯晚上不亮"), false);
});

import {
  AiError,
  requestCompletion,
  type AiConfig,
} from "../server/ai/transport.js";

const transportConfig: AiConfig = {
  mode: "live",
  baseUrl: "https://provider.invalid/v1",
  apiKey: "unit-test-only",
  model: "vision-model",
  timeoutMs: 100,
};

test("disabled or missing-key AI never invokes the network or fabricates success", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("must not be called");
  };
  for (const config of [
    { ...transportConfig, mode: "disabled" as const },
    { ...transportConfig, apiKey: "" },
  ]) {
    await assert.rejects(
      requestCompletion({ ...config, fetchImpl }, []),
      (error: unknown) =>
        error instanceof AiError && error.code === "AI_UNAVAILABLE",
    );
  }
  assert.equal(called, false);
});

test("completion transport sends configured JSON and bearer auth to the exact compatible endpoint", async () => {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    receivedUrl = String(url);
    receivedInit = init;
    return new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: '{"facts":[]}' } },
        ],
      }),
    );
  };
  assert.equal(
    await requestCompletion({ ...transportConfig, fetchImpl }, [
      { role: "user", content: "safe" },
    ]),
    '{"facts":[]}',
  );
  assert.equal(receivedUrl, "https://provider.invalid/v1/chat/completions");
  assert.equal(
    new Headers(receivedInit?.headers).get("Authorization"),
    "Bearer unit-test-only",
  );
  assert.deepEqual(JSON.parse(String(receivedInit?.body)), {
    model: "vision-model",
    stream: false,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: "safe" }],
  });
});

test("completion timeout and provider errors are failures with useful private-safe messages", async () => {
  const fetchImpl: typeof fetch = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  await assert.rejects(
    requestCompletion({ ...transportConfig, timeoutMs: 10, fetchImpl }, []),
    (error: unknown) => error instanceof AiError && error.code === "AI_TIMEOUT",
  );
  for (const response of [
    new Response("secret-provider-body-unit-test-only", { status: 401 }),
    new Response("{"),
    new Response(JSON.stringify({ choices: [{ message: { content: null } }] })),
    new Response(
      JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
      }),
    ),
  ]) {
    await assert.rejects(
      requestCompletion(
        { ...transportConfig, fetchImpl: async () => response },
        [],
      ),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.message.includes("unit-test-only"), false);
        return true;
      },
    );
  }
});

import { createAiService, buildSummary } from "../server/ai/index.js";
import type {
  AnalyzeInput,
  AnalysisResult,
  ReceiptCheckInput,
} from "../shared/types.js";

const intake: AnalyzeInput = {
  description: "楼道灯晚上不亮",
  category: "lighting",
  inputVersion: 1,
  images: [{ id: "photo-1", dataUrl: "data:image/png;base64,aW1hZ2U=" }],
};
const goodAnalysis: AnalysisResult = {
  category: "lighting",
  facts: [
    {
      id: "fact-1",
      text: "照片中可见灯具",
      origin: "photo",
      evidenceRefs: ["photo-1"],
      needsConfirmation: true,
    },
    {
      id: "fact-2",
      text: "晚上不亮",
      origin: "reported",
      evidenceRefs: ["description"],
      needsConfirmation: true,
    },
  ],
  gap: null,
  needsReview: true,
};
function modelFetch(
  outputs: unknown[],
  onRequest?: (body: Record<string, unknown>) => void,
): typeof fetch {
  let next = 0;
  return async (_url, init) => {
    onRequest?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const output = outputs[Math.min(next++, outputs.length - 1)];
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                typeof output === "string" ? output : JSON.stringify(output),
            },
          },
        ],
      }),
    );
  };
}
function analyzeWith(output: unknown) {
  return createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([output]),
  }).analyze(intake);
}

test("intake separates daytime appearance and resident night report with real image content", async () => {
  let request: Record<string, unknown> | undefined;
  const result = await createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([goodAnalysis], (body) => {
      request = body;
    }),
  }).analyze(intake);
  assert.deepEqual(result.facts, goodAnalysis.facts);
  assert.equal(result.gap, null);
  assert.equal(
    result.summary,
    "【照片观察，待核对】照片中可见灯具；【居民陈述，待核对】晚上不亮",
  );
  assert.ok(JSON.stringify(request).includes("data:image/png;base64,aW1hZ2U="));
  assert.ok(JSON.stringify(request).includes("image_url"));
});

test("analysis recovers once from malformed JSON while preserving both attempts", async () => {
  let calls = 0;
  const result = await createAiService({
    ...transportConfig,
    fetchImpl: modelFetch(["{", goodAnalysis], () => {
      calls += 1;
    }),
  }).analyze(intake);
  assert.equal(calls, 2);
  assert.equal(result.facts.length, 2);
  assert.equal(
    (result as AnalysisResult & { attempts: unknown[] }).attempts.length,
    2,
  );
});

test("analysis rejects invalid refs, missing temporal scope, invented diagnoses and unapproved gaps", async () => {
  const invalidOutputs = [
    {
      ...goodAnalysis,
      facts: [{ ...goodAnalysis.facts[0], evidenceRefs: ["other-photo"] }],
    },
    {
      ...goodAnalysis,
      facts: [{ ...goodAnalysis.facts[0], evidenceRefs: ["description"] }],
    },
    { ...goodAnalysis, facts: [{ ...goodAnalysis.facts[1], text: "灯不亮" }] },
    {
      ...goodAnalysis,
      facts: [{ ...goodAnalysis.facts[0], text: "线路老化导致灯不亮" }],
    },
    {
      ...goodAnalysis,
      facts: [{ ...goodAnalysis.facts[0], text: "灯具位于8栋102室" }],
    },
    {
      ...goodAnalysis,
      facts: [{ ...goodAnalysis.facts[0], text: "现场绝对安全" }],
    },
    {
      ...goodAnalysis,
      gap: { kind: "object", policyId: "unapproved", factIds: ["fact-1"] },
    },
    {
      ...goodAnalysis,
      gap: { kind: "object", policyId: "object-1", factIds: ["not-a-fact"] },
    },
    {
      ...goodAnalysis,
      gap: {
        kind: "conflict",
        policyId: "conflict-1",
        factIds: ["fact-1", "fact-2"],
      },
    },
    {
      ...goodAnalysis,
      facts: [
        ...goodAnalysis.facts,
        { ...goodAnalysis.facts[0], id: "f3" },
        { ...goodAnalysis.facts[0], id: "f4" },
      ],
    },
  ];
  for (const output of invalidOutputs) {
    await assert.rejects(
      analyzeWith(output),
      (error: unknown) =>
        error instanceof AiError && error.code === "AI_INVALID_OUTPUT",
    );
  }
});

test("failed analysis preserves invalid attempt evidence and never retries more than once", async () => {
  let calls = 0;
  await assert.rejects(
    createAiService({
      ...transportConfig,
      fetchImpl: modelFetch(["{"], () => {
        calls += 1;
      }),
    }).analyze(intake),
    (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, "AI_INVALID_OUTPUT");
      assert.equal(error.attempts.length, 2);
      assert.equal(error.attempts[0].raw, "{");
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("bounded approved semantic gap keeps only declared existing fact IDs", async () => {
  const output = {
    ...goodAnalysis,
    gap: { kind: "object", policyId: "object-1", factIds: ["fact-1"] },
  };
  const result = await analyzeWith(output);
  assert.deepEqual(result.gap, output.gap);
});

test("summary is program-built from valid facts and retains unknown or disputed labels", () => {
  assert.equal(
    buildSummary(goodAnalysis.facts),
    "【照片观察，待核对】照片中可见灯具；【居民陈述，待核对】晚上不亮",
  );
  assert.ok(
    buildSummary([
      { ...goodAnalysis.facts[1], text: "不确定晚上是否亮灯" },
    ]).includes("不确定"),
  );
});

const receiptInput: ReceiptCheckInput = {
  description: "楼道灯晚上不亮",
  supplements: [{ id: "supplement-1", text: "旁边扶手松动" }],
  items: [
    {
      id: "item-1",
      text: "楼道灯晚上不亮的处理情况",
      sourceRefs: [
        {
          source: "submission",
          sourceId: "description",
          quote: "楼道灯晚上不亮",
        },
      ],
    },
    {
      id: "item-2",
      text: "扶手松动的处理情况",
      sourceRefs: [
        { source: "supplement", sourceId: "supplement-1", quote: "扶手松动" },
      ],
    },
  ],
  segments: [
    { id: "segment-1", text: "楼道灯已更换灯泡，夜间效果待复查。" },
    { id: "segment-2", text: "扶手暂未处理，等待配件。" },
  ],
};
const goodCoverage = {
  rows: [
    {
      itemId: "item-1",
      status: "response_found",
      receiptTextRefs: ["segment-1"],
      explanation: "说明更换灯泡，夜间效果仍待复查。",
    },
    {
      itemId: "item-2",
      status: "response_found",
      receiptTextRefs: ["segment-2"],
      explanation: "说明暂未处理及等待配件的原因。",
    },
  ],
};

test("receipt check is text-only and responds to each manually selected item without declaring repair success", async () => {
  let payload = "";
  const result = await createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([goodCoverage], (body) => {
      payload = JSON.stringify(body);
    }),
  }).checkReceipt(receiptInput);
  assert.deepEqual(result.rows, goodCoverage.rows);
  assert.equal(payload.includes("image_url"), false);
  assert.equal(payload.includes("data:image"), false);
  assert.ok(payload.includes("segment-1"));
});

test("receipt mappings reject extra, omitted, duplicated item IDs and invented segment refs", async () => {
  const invalidOutputs = [
    { rows: goodCoverage.rows.slice(0, 1) },
    {
      rows: [
        ...goodCoverage.rows,
        { ...goodCoverage.rows[0], itemId: "extra" },
      ],
    },
    { rows: [goodCoverage.rows[0], goodCoverage.rows[0]] },
    {
      rows: [
        { ...goodCoverage.rows[0], receiptTextRefs: ["other"] },
        goodCoverage.rows[1],
      ],
    },
    {
      rows: [
        { ...goodCoverage.rows[0], receiptTextRefs: [] },
        goodCoverage.rows[1],
      ],
    },
    {
      rows: [
        { ...goodCoverage.rows[0], explanation: "已经修好，现场安全无隐患" },
        goodCoverage.rows[1],
      ],
    },
  ];
  for (const output of invalidOutputs) {
    await assert.rejects(
      createAiService({
        ...transportConfig,
        fetchImpl: modelFetch([output]),
      }).checkReceipt(receiptInput),
      (error: unknown) =>
        error instanceof AiError && error.code === "AI_INVALID_OUTPUT",
    );
  }
});

test("generic completion alone is classified missing even if the model wrongly says response found", async () => {
  const result = await createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([goodCoverage]),
  }).checkReceipt({
    ...receiptInput,
    segments: [
      { id: "segment-1", text: "已处理完成。" },
      { id: "segment-2", text: "已处理。" },
    ],
  });
  assert.ok(
    result.rows.every(
      (row) =>
        row.status === "response_missing" && row.receiptTextRefs.length === 0,
    ),
  );
});

test("invalid response item source quotes fail before sending any model request", async () => {
  let calls = 0;
  await assert.rejects(
    createAiService({
      ...transportConfig,
      fetchImpl: modelFetch([goodCoverage], () => {
        calls += 1;
      }),
    }).checkReceipt({
      ...receiptInput,
      items: [
        {
          ...receiptInput.items[0],
          sourceRefs: [
            {
              source: "supplement",
              sourceId: "supplement-1",
              quote: "不存在的原话",
            },
          ],
        },
      ],
    }),
    (error: unknown) =>
      error instanceof AiError && error.code === "AI_INVALID_INPUT",
  );
  assert.equal(calls, 0);
});

test("recovery shares one overall timeout budget instead of starting another wait", async () => {
  const realNow = Date.now;
  const start = realNow();
  let calls = 0;
  try {
    Date.now = () => start + (calls ? 101 : 0);
    const service = createAiService({
      ...transportConfig,
      timeoutMs: 100,
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "{" } }],
          }),
        );
      },
    });
    await assert.rejects(
      service.analyze(intake),
      (error: unknown) =>
        error instanceof AiError && error.code === "AI_TIMEOUT",
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = realNow;
  }
});

test("same object alone does not make day and night observations a same-context conflict", async () => {
  const context: AnalyzeInput = { ...intake, description: "同一对象晚上不亮" };
  const output = {
    ...goodAnalysis,
    gap: {
      kind: "conflict",
      policyId: "conflict-1",
      factIds: ["fact-1", "fact-2"],
    },
  };
  await assert.rejects(
    createAiService({
      ...transportConfig,
      fetchImpl: modelFetch([output]),
    }).analyze(context),
    (error: unknown) =>
      error instanceof AiError && error.code === "AI_INVALID_OUTPUT",
  );
});

test("empty intake and unknown source kinds are rejected before model calls", async () => {
  let calls = 0;
  const service = createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([goodAnalysis], () => {
      calls += 1;
    }),
  });
  await assert.rejects(
    service.analyze({ ...intake, description: " ", images: [] }),
    (error: unknown) =>
      error instanceof AiError && error.code === "AI_INVALID_INPUT",
  );
  const invalidReceipt = structuredClone(receiptInput);
  invalidReceipt.items[1].sourceRefs[0].source = "invented" as "supplement";
  await assert.rejects(
    service.checkReceipt(invalidReceipt),
    (error: unknown) =>
      error instanceof AiError && error.code === "AI_INVALID_INPUT",
  );
  assert.equal(calls, 0);
});

test("three bounded atomic facts fit the program summary without trimming original facts", async () => {
  const texts = [
    "这盏路灯昨晚没有亮灯且居民目前不确定问题的真实发生原因",
    "第二处设施在白天可见完整外观尚需工作人员进一步核实情况",
    "第三处位置的清洁事项仍存在居民表示尚未确认其处理情况",
  ];
  const input: AnalyzeInput = { ...intake, description: texts.join("；") };
  const output = {
    ...goodAnalysis,
    facts: texts.map((text, index) => ({
      id: `fact-${index}`,
      text,
      origin: "reported",
      evidenceRefs: ["description"],
      needsConfirmation: true,
    })),
  };
  const result = await createAiService({
    ...transportConfig,
    fetchImpl: modelFetch([output]),
  }).analyze(input);
  assert.equal(result.facts.length, 3);
  assert.ok(result.summary!.length <= 160);
  assert.ok(texts.every((text) => result.summary!.includes(text)));
});

test("summary refuses overlong facts rather than silently deleting critical content", () => {
  assert.throws(
    () =>
      buildSummary([{ ...goodAnalysis.facts[0], text: "待核对".repeat(60) }]),
    (error: unknown) =>
      error instanceof AiError && error.code === "AI_INVALID_OUTPUT",
  );
});
