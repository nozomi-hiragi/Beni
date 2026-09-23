import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { realpath } from "node:fs/promises";
import { BeniError } from "./types.ts";

export interface Target { root: string; projectId: string }
export interface Config {
  clientId: string;
  oauthPort: number;
  publicBaseUrl: string;
  maxConcurrent: number;
  taskTimeoutMs: number;
  maxContextRounds: number;
  dataDir: string;
  targets: Target[];
  model?: string;
}

export function defaultConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "beni", "config.json");
}

export async function loadConfig(file: string, root: string): Promise<Config> {
  const fail = () => new BeniError("config", "設定ファイルが不正です。READMEの設定例を確認してください。");
  let value: unknown;
  try { value = await Bun.file(file).json(); } catch { throw fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const v = value as Record<string, unknown>;
  const allowed = ["clientId", "oauthPort", "publicBaseUrl", "maxConcurrent", "taskTimeoutMs", "maxContextRounds", "dataDir", "projectId", "projects", "model"];
  if (Object.keys(v).some(k => !allowed.includes(k))) throw fail();
  function integer(key: string, fallback: number, min: number, max: number): number {
    const n = v[key] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw fail();
    return n;
  }
  if (typeof v.clientId !== "string" || !v.clientId.trim()) throw fail();
  if (v.model !== undefined && (typeof v.model !== "string" || !v.model.trim())) throw fail();
  if (v.dataDir !== undefined && typeof v.dataDir !== "string") throw fail();
  let publicBaseUrl: string;
  try {
    const url = new URL(String(v.publicBaseUrl));
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw fail();
    publicBaseUrl = url.origin;
  } catch { throw fail(); }
  const targets: Target[] = [];
  if (typeof v.projectId === "string" && v.projectId) targets.push({ root: await realpath(root), projectId: v.projectId });
  if (v.projects !== undefined) {
    if (!Array.isArray(v.projects)) throw fail();
    for (const p of v.projects) {
      if (!p || typeof p.path !== "string" || typeof p.projectId !== "string" || !p.projectId) throw fail();
      targets.push({ root: await realpath(resolve(p.path)), projectId: p.projectId });
    }
  }
  if (!targets.length || new Set(targets.map(t => t.projectId)).size !== targets.length) throw fail();
  return {
    clientId: v.clientId,
    oauthPort: integer("oauthPort", 3456, 1024, 65535),
    publicBaseUrl,
    maxConcurrent: integer("maxConcurrent", 2, 1, 8),
    taskTimeoutMs: integer("taskTimeoutMs", 1_800_000, 1_000, 86_400_000),
    maxContextRounds: integer("maxContextRounds", 10, 1, 100),
    dataDir: resolve(v.dataDir ?? join(homedir(), ".local", "share", "beni")),
    targets, ...(typeof v.model === "string" ? { model: v.model } : {}),
  };
}
