import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_ticket ON audit(ticket_id);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS account_site_username ON objects(json_extract(data,'$.siteId'), json_extract(data,'$.usernameNormalized')) WHERE kind='account';`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM objects WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM objects WHERE kind=?")
        .all(kind) as unknown as { data: string }[]
    ).map((x) => JSON.parse(x.data) as T);
  }
  put<T extends { id: string }>(kind: string, value: T): void {
    this.db
      .prepare(
        "INSERT INTO objects(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  remove(kind: string, id: string): void {
    this.db.prepare("DELETE FROM objects WHERE kind=? AND id=?").run(kind, id);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  replay<T>(scope: string, key: string): { hash: string; data: T } | undefined {
    const row = this.db
      .prepare("SELECT hash,data FROM idempotency WHERE scope=? AND key=?")
      .get(scope, key) as { hash: string; data: string } | undefined;
    return row
      ? { hash: row.hash, data: JSON.parse(row.data) as T }
      : undefined;
  }
  remember(scope: string, key: string, hash: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO idempotency(scope,key,hash,data) VALUES(?,?,?,?)")
      .run(scope, key, hash, JSON.stringify(data));
  }
  audit(ticketId: string, event: { id: string }): void {
    this.db
      .prepare("INSERT INTO audit(id,ticket_id,data) VALUES(?,?,?)")
      .run(event.id, ticketId, JSON.stringify(event));
  }
  events<T>(ticketId: string): T[] {
    return (
      this.db
        .prepare("SELECT data FROM audit WHERE ticket_id=? ORDER BY rowid")
        .all(ticketId) as unknown as { data: string }[]
    ).map((x) => JSON.parse(x.data) as T);
  }
  close(): void {
    this.db.close();
  }
}
