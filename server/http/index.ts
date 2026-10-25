import { createHash, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): never {
  throw new ApiError(status, code, message, details);
}
export function hash(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function version(actual: number, expected: number) {
  if (actual !== expected)
    fail(409, "VERSION_CONFLICT", "内容已经更新，请刷新核对后重试。", {
      currentVersion: actual,
    });
}
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  let status = 500,
    code = "INTERNAL_ERROR",
    message = "服务暂时不可用，请稍后重试。",
    details: unknown;
  if (error instanceof ApiError) {
    ({ status, code, message, details } = error);
  } else if (error instanceof ZodError) {
    status = 422;
    code = "VALIDATION_ERROR";
    message = "请检查输入内容。";
    details = error.issues.map((x) => ({ path: x.path, message: x.message }));
  } else if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "内容超过大小限制。";
  } else if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "LIMIT_FILE_SIZE"
  ) {
    status = 413;
    code = "FILE_TOO_LARGE";
    message = "每张图片不能超过 10 MB。";
  } else if (error instanceof Error && error.name === "MulterError") {
    status = 422;
    code = "INVALID_UPLOAD";
    message = "每次请选择一张有效图片。";
  } else if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 400
  ) {
    status = 400;
    code = "INVALID_JSON";
    message = "请求内容格式无效。";
  }
  if (status === 500)
    console.error(
      JSON.stringify({
        level: "error",
        requestId: res.locals.requestId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: res.locals.requestId,
    },
    requestId: res.locals.requestId,
  });
}
export function rateLimit(
  max: number,
  windowMs: number,
  options: {
    key?: (req: Request, res: Response) => string;
    skipSuccessful?: boolean;
  } = {},
) {
  const counts = new Map<string, { n: number; until: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key =
      options.key?.(req, res) ??
      String(res.locals.principal?.id || req.ip || "unknown");
    const t = Date.now();
    let c = counts.get(key);
    if (!c || c.until < t) {
      c = { n: 0, until: t + windowMs };
      counts.set(key, c);
    }
    c.n++;
    if (c.n > max) {
      res.set("Retry-After", String(Math.ceil((c.until - t) / 1000)));
      return next(
        new ApiError(429, "RATE_LIMITED", "操作较频繁，请稍后再试。"),
      );
    }
    if (options.skipSuccessful) {
      const bucket = c;
      res.once("finish", () => {
        if (res.statusCode < 400) bucket.n = Math.max(0, bucket.n - 1);
      });
    }
    if (counts.size > 10000)
      for (const [k, v] of counts) if (v.until < t) counts.delete(k);
    next();
  };
}
