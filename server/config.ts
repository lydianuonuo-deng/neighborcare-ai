import path from "node:path";
import type { AiConfig } from "../shared/types.js";

export interface AppConfig {
  port: number;
  host: string;
  origin: string;
  production: boolean;
  demoMode: boolean;
  dbPath: string;
  uploadDir: string;
  staffUsername: string;
  staffPassword: string;
  adminUsername: string;
  adminPassword: string;
  sessionDays: number;
  semanticEnabled: boolean;
  receiptCheckEnabled: boolean;
  responseItemsEnabled: boolean;
  ai: AiConfig;
  pilotEndAt?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT || 3030);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a valid port");
  const production = env.NODE_ENV === "production";
  const pilotEndAt = env.PILOT_END_AT || undefined;
  if (
    pilotEndAt &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(pilotEndAt) ||
      !Number.isFinite(Date.parse(pilotEndAt)))
  )
    throw new Error("PILOT_END_AT must be an ISO date-time");
  const demoMode = env.DEMO_MODE !== "false";
  const staffPassword =
    env.STAFF_PASSWORD || (demoMode ? "LinliDemo-2026!" : "");
  if (staffPassword.length < 12 || staffPassword.length > 128)
    throw new Error("Set STAFF_PASSWORD with 12–128 characters");
  const staffUsername = env.STAFF_USERNAME || "demo";
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(staffUsername))
    throw new Error(
      "STAFF_USERNAME must contain 3–32 letters, digits, underscores or hyphens",
    );
  const adminUsername = env.ADMIN_USERNAME || (demoMode ? "admin" : "");
  const adminPassword =
    env.ADMIN_PASSWORD || (demoMode ? "LinliAdmin-2026!" : "");
  if (
    !/^[A-Za-z0-9_-]{3,32}$/.test(adminUsername) ||
    adminPassword.length < 12 ||
    adminPassword.length > 128
  )
    throw new Error(
      "Set ADMIN_USERNAME and ADMIN_PASSWORD (12–128 characters) explicitly for pilot mode",
    );
  if (
    adminUsername.toLowerCase() === (env.STAFF_USERNAME || "demo").toLowerCase()
  )
    throw new Error("ADMIN_USERNAME must differ from STAFF_USERNAME");
  const apiKey = env.AI_API_KEY || "";
  const baseUrl = (
    env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/$/, "");
  if (
    !/^https:\/\//.test(baseUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)
  )
    throw new Error("AI_BASE_URL must use HTTPS or loopback HTTP");
  return {
    port,
    host: env.HOST || "127.0.0.1",
    origin: env.APP_ORIGIN || `http://localhost:${port}`,
    production,
    demoMode,
    pilotEndAt,
    dbPath: path.resolve(env.DB_PATH || ".data/linli.sqlite"),
    uploadDir: path.resolve(env.UPLOAD_DIR || ".data/uploads"),
    staffUsername,
    staffPassword,
    adminUsername,
    adminPassword,
    sessionDays: 30,
    semanticEnabled: env.ENABLE_SEMANTIC_QUESTIONS === "true",
    receiptCheckEnabled: env.ENABLE_RECEIPT_CHECK !== "false",
    responseItemsEnabled: env.ENABLE_RESPONSE_ITEMS !== "false",
    ai: {
      mode: apiKey ? "live" : "disabled",
      apiKey,
      baseUrl,
      model: env.AI_MODEL || "qwen-vl-plus",
      timeoutMs: 25000,
    },
  };
}
