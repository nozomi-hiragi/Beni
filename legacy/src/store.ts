import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { BeniError, type SessionState, type Step } from "./types.ts";

export function operationId(...parts: string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function planHash(steps: Step[]): string {
  return createHash("sha256").update(JSON.stringify(steps.map(t => ({ key: t.key, title: t.title, description: t.description, priority: t.priority, dependsOn: t.dependsOn })))).digest("hex");
}

export class Store {
  private db: Database;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inputs (session TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(session,id));
      CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, session TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get(id: string): SessionState | undefined {
    const row = this.db.query<{ state: string }, [string]>("SELECT state FROM sessions WHERE id=?").get(id);
    return row ? JSON.parse(row.state) as SessionState : undefined;
  }
  all(): SessionState[] {
    return this.db.query<{ state: string }, []>("SELECT state FROM sessions ORDER BY rowid").all().map(r => JSON.parse(r.state) as SessionState);
  }
  save(s: SessionState): void {
    this.db.run("INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", [s.id, JSON.stringify(s)]);
  }
  seen(session: string, id: string): boolean {
    return !!this.db.query("SELECT 1 FROM inputs WHERE session=? AND id=?").get(session, id);
  }
  mark(session: string, id: string): void { this.db.run("INSERT OR IGNORE INTO inputs VALUES (?,?)", [session, id]); }
  meta(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.run("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
  }
  enqueueWebhook(id: string, session: string): boolean {
    return this.db.run("INSERT OR IGNORE INTO webhooks(id,session) VALUES (?,?)", [id, session]).changes > 0;
  }
  pendingWebhooks(): { id: string; session: string }[] {
    return this.db.query<{ id: string; session: string }, []>("SELECT id,session FROM webhooks WHERE done=0 ORDER BY rowid").all();
  }
  finishWebhook(id: string): void { this.db.run("UPDATE webhooks SET done=1 WHERE id=?", [id]); }
  claim(): void {
    this.db.transaction(() => {
      const owner = Number(this.meta("pid"));
      if (owner) {
        let active = true;
        try { process.kill(owner, 0); } catch (error) { active = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (active) throw new BeniError("already_running", "Beniはすでに起動しています。");
      }
      this.setMeta("pid", String(process.pid));
      for (const state of this.all()) {
        if (state.phase === "running" || state.phase === "planning") {
          state.phase = "stopped";
          state.errorCode = "interrupted";
          this.save(state);
        }
      }
    }).immediate();
  }
  release(): void {
    if (this.meta("pid") === String(process.pid)) this.setMeta("pid", "0");
  }
  close(): void { this.db.close(); }
}
