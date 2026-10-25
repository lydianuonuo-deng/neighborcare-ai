import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createAiService } from "./ai/index.js";

const config = loadConfig();
const { app, close } = createApp({ config, ai: createAiService(config.ai) });
const server = createHttpServer(app);
let vite: { close(): Promise<void> } | undefined;
if (!config.production && process.env.SERVE_STATIC !== "true") {
  const { createServer } = await import("vite");
  const dev = await createServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  vite = dev;
  app.use(dev.middlewares);
} else {
  const dist = path.resolve("dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => {
    if (!fs.existsSync(path.join(dist, "index.html")))
      return res.status(503).send("请先执行 npm run build");
    res.sendFile(path.join(dist, "index.html"));
  });
}
server.listen(config.port, config.host, () => {
  console.info(
    JSON.stringify({
      event: "listening",
      url: config.origin,
      demo: config.demoMode,
      ai: config.ai.mode,
    }),
  );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await vite?.close();
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
