import { Database } from 'bun:sqlite';
import { lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus } from '../agents/agent';
import { readJson } from '../data';
import { restoreRateLimitUsage } from '../rate-limits';
import { isAgentId, type AgentId, type RateLimitUsage } from '../../shared/agent';

type Row = {availability: string | null; auth: string | null; models: string | null; version: string | null; executable_path: string | null; checked_at: string | null; account_key: string | null; status_invalidated: number};
function validStatus(value: AgentStatus) {
  return ['ready','not-installed','unsupported-version','unavailable'].includes(value.availability) &&
    ['subscription','api-key','other','none','unknown','not-required'].includes(value.auth) &&
    typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt)) &&
    (value.models === null || Array.isArray(value.models) && value.models.every(model => model && typeof model.id === 'string' && typeof model.name === 'string')) &&
    [value.version,value.executablePath,value.accountKey].every(item => item === undefined || typeof item === 'string');
}
export class AgentTable {
  constructor(private readonly db: Database, dataDirectory?: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, availability TEXT, auth TEXT, models TEXT, version TEXT,
      executable_path TEXT, checked_at TEXT, account_key TEXT, status_invalidated INTEGER NOT NULL DEFAULT 0,
      usage_identity TEXT, usage TEXT)`);
    db.transaction(() => {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_usage_cache'").get()) return;
      const rows = db.query<{provider:string;identity:string;usage:string},[]>('SELECT provider,identity,usage FROM agent_usage_cache').all();
      for (const row of rows) {
        // 破損した旧値も保管し、読出し時の検証と次の取得で回復させる。
        db.query('INSERT INTO agents(id,name,usage_identity,usage) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET usage_identity=excluded.usage_identity,usage=excluded.usage WHERE agents.usage IS NULL AND agents.usage_identity IS NULL')
          .run(row.provider,row.provider,row.identity,row.usage);
      }
      db.exec('DROP TABLE agent_usage_cache');
    }).immediate();
    if (dataDirectory) for (const id of ['codex','claude']) {
      try {
        const path=join(dataDirectory,`rate-limits-${id}.json`),stat=lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1) continue;
        const saved=readJson(path);
        if (saved?.version !== 1 || typeof saved.identity !== 'string' || !saved.identity || saved.identity.length > 4096) continue;
        const usage=restoreRateLimitUsage(saved.usage);
        if (usage === 'unknown') continue;
        db.transaction(() => this.importUsage(id,saved.identity,usage)).immediate();
        if (this.agentUsage(id)) rmSync(path);
      } catch { /* 移行できなかった旧ファイルは保持する。 */ }
    }
  }
  private importUsage(id: AgentId, identity: string, usage: Exclude<RateLimitUsage,'unknown'>) {
    this.db.query('INSERT INTO agents(id,name,usage_identity,usage) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET usage_identity=excluded.usage_identity,usage=excluded.usage WHERE agents.usage IS NULL AND agents.usage_identity IS NULL').run(id,id,identity,JSON.stringify(usage));
  }
  registerAgents(agents: readonly {id:string;name:string}[]) {
    this.db.transaction(() => {
      for (const agent of agents) {
        if (!isAgentId(agent.id) || typeof agent.name !== 'string' || !agent.name) throw Error('エージェントの登録情報が不正です');
        this.db.query('INSERT INTO agents(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(agent.id,agent.name);
      }
    }).immediate();
  }
  agentStatus(id: AgentId): AgentStatus | undefined {
    const row=this.db.query<Row,[string]>('SELECT availability,auth,models,version,executable_path,checked_at,account_key,status_invalidated FROM agents WHERE id=?').get(id);
    if (!row || row.status_invalidated !== 0 || row.checked_at === null || row.models === null) return;
    try {
      const status={availability:row.availability,auth:row.auth,models:JSON.parse(row.models),checkedAt:row.checked_at,
        ...(row.version === null ? {} : {version:row.version}),...(row.executable_path === null ? {} : {executablePath:row.executable_path}),...(row.account_key === null ? {} : {accountKey:row.account_key})} as AgentStatus;
      if (validStatus(status)) return status;
    } catch { /* 破損した接続情報は再確認する。 */ }
  }
  saveAgentStatus(id: AgentId, status: AgentStatus) {
    if (!isAgentId(id) || !validStatus(status)) throw Error('エージェントの接続情報が不正です');
    this.db.query(`INSERT INTO agents(id,name,availability,auth,models,version,executable_path,checked_at,account_key,status_invalidated) VALUES(?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET availability=excluded.availability,auth=excluded.auth,models=excluded.models,version=excluded.version,executable_path=excluded.executable_path,checked_at=excluded.checked_at,account_key=excluded.account_key,status_invalidated=0`)
      .run(id,id,status.availability,status.auth,JSON.stringify(status.models),status.version ?? null,status.executablePath ?? null,status.checkedAt,status.accountKey ?? null);
  }
  invalidateAgentStatus(id: AgentId) { this.db.query('UPDATE agents SET status_invalidated=1 WHERE id=?').run(id); }
  agentUsage(id: AgentId): {identity:string;usage:Exclude<RateLimitUsage,'unknown'>} | undefined {
    const row=this.db.query<{identity:string|null;usage:string|null},[string]>('SELECT usage_identity AS identity,usage FROM agents WHERE id=?').get(id);
    if (!row?.identity || row.identity.length > 4096 || row.usage === null) return;
    try { const usage=restoreRateLimitUsage(JSON.parse(row.usage)); if (usage !== 'unknown') return {identity:row.identity,usage}; } catch { /* 再取得で回復する。 */ }
  }
  saveAgentUsage(id: AgentId, identity: string, value: RateLimitUsage) {
    const usage=restoreRateLimitUsage(value);
    if (!isAgentId(id) || !identity || identity.length > 4096 || usage === 'unknown') throw Error('利用枠キャッシュが不正です');
    this.db.transaction(() => {
      const previous=this.agentUsage(id);
      if (previous?.identity === identity && Date.parse(previous.usage.observedAt) > Date.parse(usage.observedAt)) return;
      this.db.query('INSERT INTO agents(id,name,usage_identity,usage) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET usage_identity=excluded.usage_identity,usage=excluded.usage').run(id,id,identity,JSON.stringify(usage));
    }).immediate();
  }
}
