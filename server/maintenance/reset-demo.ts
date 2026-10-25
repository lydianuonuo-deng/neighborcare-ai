import "dotenv/config";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { Store } from "../db/index.js";

type Data = Record<string, unknown>;
interface ObjectRow {
  kind: string;
  id: string;
  data: string;
}
interface ParsedRow {
  kind: string;
  id: string;
  data: Data;
}
export interface ResetDemoResult {
  objects: number;
  credentials: number;
  events: number;
  submissions: number;
  files: number;
}
const textField = (data: Data, field: string) =>
  typeof data[field] === "string" ? (data[field] as string) : undefined;
const objectField = (data: Data, field: string): Data | undefined => {
  const value = data[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : undefined;
};

/** Run with the service stopped; site and location configuration deliberately survive a reset. */
export function resetDemo(store: Store, uploadDir: string): ResetDemoResult {
  const rows = (
    store.db
      .prepare("SELECT kind,id,data FROM objects")
      .all() as unknown as ObjectRow[]
  ).map((row) => ({ ...row, data: JSON.parse(row.data) as Data }));
  const marked = new Set<string>();
  const ticketIds = new Set<string>();
  const draftIds = new Set<string>();
  const taskIds = new Set<string>();
  const principalIds = new Set<string>();
  const key = (row: ParsedRow) => `${row.kind}:${row.id}`;
  const eligible = (row: ParsedRow) =>
    !["site", "location"].includes(row.kind) &&
    (!textField(row.data, "siteId") || row.data.siteId === "demo");
  const mark = (row: ParsedRow) => {
    if (!eligible(row)) return false;
    const added = !marked.has(key(row));
    marked.add(key(row));
    if (row.kind === "ticket") {
      ticketIds.add(row.id);
      const draftId = textField(row.data, "draftId");
      if (draftId) draftIds.add(draftId);
      const checkTaskId = textField(
        objectField(row.data, "receiptDraft") || {},
        "checkTaskId",
      );
      if (checkTaskId) taskIds.add(checkTaskId);
    }
    if (row.kind === "draft") {
      draftIds.add(row.id);
      const taskId = textField(row.data, "analysisTaskId");
      if (taskId) taskIds.add(taskId);
    }
    if (row.kind === "task") taskIds.add(row.id);
    if (row.kind === "receipt_draft_history") {
      const taskId = textField(row.data, "checkTaskId");
      if (taskId) taskIds.add(taskId);
    }
    const ownerId = textField(row.data, "ownerId");
    if (ownerId) principalIds.add(ownerId);
    return added;
  };

  const credentials = (
    store.db.prepare("SELECT hash,data FROM credentials").all() as unknown as {
      hash: string;
      data: string;
    }[]
  ).map((row) => ({ ...row, parsed: JSON.parse(row.data) as Data }));
  const demoCredentials = credentials.filter(
    (row) => row.parsed.siteId === "demo",
  );
  for (const credential of demoCredentials) {
    const principalId = textField(credential.parsed, "id");
    if (principalId) principalIds.add(principalId);
  }
  for (const row of rows) if (row.data.siteId === "demo") mark(row);
  // Follow persisted references for child objects that do not repeat siteId.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!eligible(row) || marked.has(key(row))) continue;
      const ticketId = textField(row.data, "ticketId");
      const submittedTicketId = textField(row.data, "submittedTicketId");
      const draftId =
        textField(row.data, "draftId") ||
        textField(row.data, "originatingDraftId");
      const taskId = textField(row.data, "taskId");
      const ownerId = textField(row.data, "ownerId");
      const owned =
        (!!ticketId && ticketIds.has(ticketId)) ||
        (!!submittedTicketId && ticketIds.has(submittedTicketId)) ||
        (!!draftId && draftIds.has(draftId)) ||
        (!!taskId && taskIds.has(taskId)) ||
        (row.kind === "task" && taskIds.has(row.id)) ||
        (row.kind === "draft" && draftIds.has(row.id)) ||
        (!!ownerId && principalIds.has(ownerId));
      if (owned && mark(row)) changed = true;
    }
  }

  const uploadRoot = resolve(uploadDir);
  const physicalUploadRoot = existsSync(uploadRoot)
    ? realpathSync(uploadRoot)
    : uploadRoot;
  const protectedFiles = new Set(
    rows
      .filter((row) => row.kind === "attachment" && !marked.has(key(row)))
      .map((row) => textField(row.data, "path"))
      .filter((path): path is string => !!path)
      .map((path) => resolve(path)),
  );
  const files = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "attachment" || !marked.has(key(row))) continue;
    const path = textField(row.data, "path");
    if (!path) continue;
    const resolvedPath = resolve(path);
    const childPath = relative(uploadRoot, resolvedPath);
    if (
      !childPath ||
      childPath === ".." ||
      childPath.startsWith(`..${sep}`) ||
      isAbsolute(childPath)
    ) {
      throw new Error(
        "Refusing demo reset: an attachment path is outside the configured upload directory.",
      );
    }
    const parent = dirname(resolvedPath);
    if (existsSync(parent)) {
      const physicalParent = relative(physicalUploadRoot, realpathSync(parent));
      if (
        physicalParent === ".." ||
        physicalParent.startsWith(`..${sep}`) ||
        isAbsolute(physicalParent)
      ) {
        throw new Error(
          "Refusing demo reset: an attachment path is outside the configured upload directory.",
        );
      }
    }
    if (protectedFiles.has(resolvedPath)) continue;
    if (existsSync(resolvedPath) && lstatSync(resolvedPath).isDirectory()) {
      throw new Error(
        "Refusing demo reset: an attachment path points to a directory.",
      );
    }
    files.add(resolvedPath);
  }

  const submissions = store.db
    .prepare("SELECT scope,key,data FROM idempotency")
    .all() as unknown as { scope: string; key: string; data: string }[];
  const demoSubmissions = submissions.filter((row) => {
    const data = JSON.parse(row.data) as Data;
    const ticket = objectField(data, "ticket");
    if (ticket?.siteId && ticket.siteId !== "demo") return false;
    const ticketId = ticket ? textField(ticket, "id") : undefined;
    if (ticket?.siteId === "demo" || (!!ticketId && ticketIds.has(ticketId)))
      return true;
    if (row.scope.startsWith("submit:"))
      return principalIds.has(row.scope.slice("submit:".length));
    if (row.scope.startsWith("event:"))
      return ticketIds.has(row.scope.split(":")[1] || "");
    return false;
  });

  const result: ResetDemoResult = {
    objects: 0,
    credentials: 0,
    events: 0,
    submissions: 0,
    files: 0,
  };
  store.tx(() => {
    for (const row of rows)
      if (marked.has(key(row))) {
        store.remove(row.kind, row.id);
        result.objects++;
      }
    for (const row of demoCredentials)
      result.credentials += Number(
        store.db.prepare("DELETE FROM credentials WHERE hash=?").run(row.hash)
          .changes,
      );
    for (const ticketId of ticketIds)
      result.events += Number(
        store.db.prepare("DELETE FROM audit WHERE ticket_id=?").run(ticketId)
          .changes,
      );
    for (const row of demoSubmissions)
      result.submissions += Number(
        store.db
          .prepare("DELETE FROM idempotency WHERE scope=? AND key=?")
          .run(row.scope, row.key).changes,
      );
  });
  for (const path of files) {
    try {
      unlinkSync(path);
      result.files++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

export function runResetCli(args: string[] = process.argv.slice(2)): void {
  if (args.length === 1 && args[0] === "--help") {
    console.info(
      "Stop the service first. Then run: npm run reset:demo -- --confirm-demo-reset",
    );
    return;
  }
  if (args.length !== 1 || args[0] !== "--confirm-demo-reset") {
    throw new Error(
      "Stop the service first. Demo reset requires the explicit --confirm-demo-reset flag.",
    );
  }
  const config = loadConfig();
  if (!config.demoMode)
    throw new Error("Demo reset is disabled when DEMO_MODE=false.");
  if (!existsSync(config.dbPath))
    throw new Error(
      "Database does not exist; verify DB_PATH before resetting demo data.",
    );
  const store = new Store(config.dbPath);
  try {
    console.info(
      JSON.stringify({
        event: "demo_reset_complete",
        ...resetDemo(store, config.uploadDir),
      }),
    );
  } finally {
    store.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runResetCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Demo reset failed.",
    );
    process.exitCode = 1;
  }
}
