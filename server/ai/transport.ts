import type { AiConfig } from "../../shared/types.js";
export type { AiConfig } from "../../shared/types.js";

export class AiError extends Error {
  readonly code: string;
  attempts: Array<{ raw: string; valid: boolean; error?: string }> = [];

  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

/** One HTTP request. Semantic recovery belongs to the caller's shared deadline. */
export async function requestCompletion(
  config: AiConfig,
  messages: unknown[],
  budgetMs = config.timeoutMs,
): Promise<string> {
  if (config.mode !== "live" || !config.apiKey.trim() || !config.model.trim()) {
    throw new AiError("AI_UNAVAILABLE", "AI 服务尚未配置，可以继续人工填写。");
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl.replace(/\/+$/u, "") + "/chat/completions");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("invalid");
  } catch {
    throw new AiError(
      "AI_UNAVAILABLE",
      "AI 服务地址配置无效，可以继续人工填写。",
    );
  }
  const duration = Math.min(25_000, config.timeoutMs, budgetMs);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new AiError(
      "AI_TIMEOUT",
      "AI 等待超时，可以继续人工填写或稍后重试。",
    );
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AiError("AI_TIMEOUT", "AI 等待超时，可以继续人工填写或稍后重试。"),
      );
      controller.abort();
    }, duration);
  });
  const operation = async () => {
    const response = await (config.fetchImpl ?? fetch)(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new AiError(
        "AI_UNAVAILABLE",
        `AI 服务暂不可用（HTTP ${response.status}），可以继续人工填写。`,
      );
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "AI 返回的内容格式无效，请人工核对。",
      );
    }
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("choices" in envelope) ||
      !Array.isArray(envelope.choices)
    ) {
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "AI 返回的内容格式无效，请人工核对。",
      );
    }
    const choice: unknown = envelope.choices[0];
    if (
      typeof choice !== "object" ||
      choice === null ||
      !("message" in choice) ||
      typeof choice.message !== "object" ||
      choice.message === null ||
      !("content" in choice.message) ||
      typeof choice.message.content !== "string" ||
      !choice.message.content.trim() ||
      ("finish_reason" in choice && choice.finish_reason !== "stop")
    ) {
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "AI 没有返回完整的结构化内容，请人工核对。",
      );
    }
    if (choice.message.content.length > 30_000)
      throw new AiError(
        "AI_INVALID_OUTPUT",
        "AI 返回内容超出限制，请人工核对。",
      );
    return choice.message.content;
  };
  try {
    return await Promise.race([operation(), timeout]);
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(
      "AI_UNAVAILABLE",
      "AI 网络连接失败，可以继续人工填写或稍后重试。",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
