import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Store } from "../server/db/index.js";
import { resetDemo } from "../server/maintenance/reset-demo.js";

const cliCommand = fileURLToPath(
  new URL("../server/maintenance/reset-demo.ts", import.meta.url),
);
const tsxLoader = import.meta.resolve("tsx");

function runIsolatedCli(
  directory: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
) {
  const fixtureRoot = realpathSync(directory);
  const relativeRoot = relative(realpathSync(tmpdir()), fixtureRoot);
  if (
    !relativeRoot ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRoot)
  ) {
    throw new Error("CLI tests require a temporary fixture directory as cwd.");
  }
  const databasePath = join(fixtureRoot, "must-not-create.sqlite");
  const uploadDir = join(fixtureRoot, "uploads");
  const envFile = join(fixtureRoot, "maintenance.env");
  // Both the cwd and all configured paths are temporary, even if dotenv stops loading.
  return spawnSync(
    process.execPath,
    ["--import", tsxLoader, cliCommand, ...args],
    {
      cwd: fixtureRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        STAFF_PASSWORD: "test-reset-password",
        ADMIN_USERNAME: "testadmin",
        ADMIN_PASSWORD: "test-admin-password",
        ...env,
        DB_PATH: databasePath,
        UPLOAD_DIR: uploadDir,
        DOTENV_CONFIG_PATH: envFile,
      },
      encoding: "utf8",
    },
  );
}

test("manual demo reset removes only demo-owned records and files while preserving pilot and configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "linli-reset-"));
  const uploadDir = join(directory, "uploads");
  mkdirSync(uploadDir);
  const store = new Store(join(directory, "test.sqlite"));
  try {
    for (const siteId of ["demo", "pilot"]) {
      store.put("site", { id: siteId, name: siteId, demo: siteId === "demo" });
      store.put("location", { id: `${siteId}-entrance`, siteId, name: "入口" });
      store.put("draft", {
        id: `${siteId}-draft`,
        siteId,
        ownerId: `${siteId}-resident`,
        analysisTaskId: `${siteId}-analysis`,
      });
      store.put("ticket", {
        id: `${siteId}-ticket`,
        siteId,
        ownerId: `${siteId}-resident`,
        draftId: `${siteId}-draft`,
        receiptDraft: { checkTaskId: `${siteId}-check` },
      });
      for (const taskId of [`${siteId}-analysis`, `${siteId}-check`]) {
        store.put("task", {
          id: taskId,
          siteId,
          ownerId: `${siteId}-resident`,
          ticketId: `${siteId}-ticket`,
        });
        store.put("ai_run", {
          id: `${taskId}-run`,
          taskId,
          attempts: [{ raw: "private model output", valid: true }],
        });
      }
      store.put("receipt_draft_history", {
        id: `${siteId}-receipt-history`,
        ticketId: `${siteId}-ticket`,
        checkTaskId: `${siteId}-check`,
      });
      const path = join(uploadDir, `${siteId}.webp`);
      writeFileSync(path, "private image");
      store.put("attachment", {
        id: `${siteId}-attachment`,
        siteId,
        ticketId: `${siteId}-ticket`,
        path,
      });
      store.db
        .prepare("INSERT INTO credentials(hash,kind,data) VALUES(?,?,?)")
        .run(
          `${siteId}-credential`,
          "resident",
          JSON.stringify({ id: `${siteId}-resident`, siteId }),
        );
      store.audit(`${siteId}-ticket`, { id: `${siteId}-event` });
      store.remember(
        `submit:${siteId}-resident`,
        "original-key",
        "snapshot-hash",
        { ticket: { id: `${siteId}-ticket`, siteId } },
      );
      store.remember(
        `event:${siteId}-ticket:resident:${siteId}-resident`,
        "event-key",
        "event-hash",
        { ticket: { id: `${siteId}-ticket`, siteId } },
      );
    }
    const orphanPath = join(uploadDir, "demo-orphan.webp");
    writeFileSync(orphanPath, "old private image");
    store.put("attachment", {
      id: "demo-orphan",
      siteId: "demo",
      draftId: "deleted-draft",
      path: orphanPath,
    });

    const result = resetDemo(store, uploadDir);
    assert.ok(result.objects > 0);
    assert.equal(result.files, 2);
    for (const kind of [
      "draft",
      "ticket",
      "attachment",
      "task",
      "ai_run",
      "receipt_draft_history",
    ]) {
      const rows = store.all<{ id: string }>(kind);
      assert.ok(
        rows.every((row) => row.id.startsWith("pilot-")),
        `${kind} must retain only pilot rows`,
      );
      assert.ok(rows.length > 0, `${kind} pilot rows must remain`);
    }
    for (const siteId of ["demo", "pilot"]) {
      assert.ok(store.get("site", siteId));
      assert.ok(store.get("location", `${siteId}-entrance`));
    }
    assert.equal(
      store.db
        .prepare("SELECT hash FROM credentials WHERE hash=?")
        .get("demo-credential"),
      undefined,
    );
    assert.ok(
      store.db
        .prepare("SELECT hash FROM credentials WHERE hash=?")
        .get("pilot-credential"),
    );
    assert.equal(store.events("demo-ticket").length, 0);
    assert.equal(store.events("pilot-ticket").length, 1);
    assert.equal(
      store.replay("submit:demo-resident", "original-key"),
      undefined,
    );
    assert.ok(store.replay("submit:pilot-resident", "original-key"));
    assert.equal(
      store.replay("event:demo-ticket:resident:demo-resident", "event-key"),
      undefined,
    );
    assert.ok(
      store.replay("event:pilot-ticket:resident:pilot-resident", "event-key"),
    );
    assert.equal(existsSync(join(uploadDir, "demo.webp")), false);
    assert.equal(existsSync(orphanPath), false);
    assert.ok(existsSync(join(uploadDir, "pilot.webp")));
    assert.deepEqual(resetDemo(store, uploadDir), {
      objects: 0,
      credentials: 0,
      events: 0,
      submissions: 0,
      files: 0,
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset refuses attachment paths that escape through a symlink and preserves their files", () => {
  const directory = mkdtempSync(join(tmpdir(), "linli-reset-symlink-"));
  const uploadDir = join(directory, "uploads");
  const unrelatedDir = join(directory, "unrelated");
  mkdirSync(uploadDir);
  mkdirSync(unrelatedDir);
  const privateFile = join(unrelatedDir, "keep.webp");
  writeFileSync(privateFile, "unrelated private file");
  symlinkSync(unrelatedDir, join(uploadDir, "outside"));
  const store = new Store(join(directory, "test.sqlite"));
  try {
    store.put("attachment", {
      id: "demo-escape",
      siteId: "demo",
      path: join(uploadDir, "outside", "keep.webp"),
    });
    assert.throws(
      () => resetDemo(store, uploadDir),
      /outside the configured upload directory/,
    );
    assert.ok(existsSync(privateFile));
    assert.ok(store.get("attachment", "demo-escape"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset CLI refuses missing confirmation and pilot mode before opening a database", () => {
  const directory = mkdtempSync(join(tmpdir(), "linli-reset-cli-"));
  const databasePath = join(directory, "must-not-create.sqlite");
  const uploadDir = join(directory, "uploads");
  writeFileSync(
    join(directory, "maintenance.env"),
    `DB_PATH=${databasePath}\nUPLOAD_DIR=${uploadDir}\n`,
  );
  try {
    for (const [args, demoMode, message] of [
      [[], "true", /requires the explicit/],
      [["--confirm-demo-reset"], "false", /DEMO_MODE=false/],
    ] as const) {
      const result = runIsolatedCli(directory, args, { DEMO_MODE: demoMode });
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.equal(existsSync(databasePath), false);
      assert.equal(existsSync(uploadDir), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset CLI reads pilot-mode protection from the dotenv configuration file", () => {
  const directory = mkdtempSync(join(tmpdir(), "linli-reset-dotenv-"));
  const databasePath = join(directory, "must-not-create.sqlite");
  const uploadDir = join(directory, "uploads");
  writeFileSync(
    join(directory, "maintenance.env"),
    `DEMO_MODE=false\nSTAFF_PASSWORD=test-reset-password\nADMIN_USERNAME=testadmin\nADMIN_PASSWORD=test-admin-password\nDB_PATH=${databasePath}\nUPLOAD_DIR=${uploadDir}\n`,
  );
  try {
    const result = runIsolatedCli(directory, ["--confirm-demo-reset"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEMO_MODE=false/);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(uploadDir), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI test harness rejects the application directory before spawning a process", () => {
  const appDirectory = fileURLToPath(new URL("..", import.meta.url));
  assert.throws(
    () => runIsolatedCli(appDirectory, ["--help"]),
    /temporary fixture directory/,
  );
});
