import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";

const run = randomUUID();
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3031",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1366, height: 900 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npx tsx server/index.ts",
    url: "http://127.0.0.1:3031/api/health",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "test",
      SERVE_STATIC: "true",
      HOST: "127.0.0.1",
      PORT: "3031",
      APP_ORIGIN: "http://127.0.0.1:3031",
      DEMO_MODE: "true",
      STAFF_USERNAME: "demo",
      STAFF_PASSWORD: "LinliDemo-2026!",
      AI_API_KEY: "",
      DB_PATH: `.data/e2e-${run}.sqlite`,
      UPLOAD_DIR: `.data/e2e-${run}-uploads`,
    },
  },
});
