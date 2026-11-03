import { createHash, randomBytes } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { BeniError } from "./types.ts";

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  appUserId: string;
  organizationId: string;
}
export interface SecretStore {
  get(): Promise<Credentials | null>;
  set(value: Credentials): Promise<void>;
  delete(): Promise<void>;
}

export class Keychain implements SecretStore {
  constructor(private clientId: string) {}
  async get(): Promise<Credentials | null> {
    const value = await Bun.secrets.get({ service: "beni.linear", name: this.clientId });
    return value ? JSON.parse(value) as Credentials : null;
  }
  async set(value: Credentials): Promise<void> {
    await Bun.secrets.set({ service: "beni.linear", name: this.clientId, value: JSON.stringify(value) });
  }
  async delete(): Promise<void> { await Bun.secrets.delete({ service: "beni.linear", name: this.clientId }); }
}

export async function exchangeToken(body: URLSearchParams, signal?: AbortSignal) {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST", body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new BeniError("oauth", "Linear認証に失敗しました。loginで再接続してください。");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new BeniError("oauth", "Linear認証応答が不正です。");
  const v = value as Record<string, unknown>;
  if (typeof v.access_token !== "string" || typeof v.refresh_token !== "string" || typeof v.expires_in !== "number" || v.expires_in <= 0) {
    throw new BeniError("oauth", "Linear認証応答が不正です。");
  }
  return { accessToken: v.access_token, refreshToken: v.refresh_token, expiresAt: Date.now() + v.expires_in * 1000 };
}

export class Auth {
  private refreshing?: Promise<Credentials>;
  constructor(private clientId: string, private secrets: SecretStore) {}
  async credentials(signal?: AbortSignal): Promise<Credentials> {
    const saved = await this.secrets.get();
    if (!saved) throw new BeniError("not_connected", "Linearに未接続です。loginを実行してください。");
    if (saved.expiresAt > Date.now() + 60_000) return saved;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const tokens = await exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: this.clientId, refresh_token: saved.refreshToken }), signal);
        const next = { ...saved, ...tokens };
        await this.secrets.set(next);
        return next;
      })().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }
  async logout(): Promise<void> {
    const saved = await this.secrets.get();
    if (!saved) return;
    const response = await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST", body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: "refresh_token" }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new BeniError("revoke", "認証の解除に失敗しました。Linear側の接続状態を確認してください。");
    await this.secrets.delete();
  }
}

export function createAuthorization(clientId: string, publicBaseUrl: string) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const redirect = `${publicBaseUrl}/oauth/callback`;
  const url = new URL("https://linear.app/oauth/authorize");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", actor: "app", scope: "read,write,app:assignable,app:mentionable", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return { state, verifier, redirect, url: url.toString() };
}

export async function login(clientId: string, port: number, secrets: SecretStore, publicBaseUrl: string, signal?: AbortSignal): Promise<void> {
  const auth = createAuthorization(clientId, publicBaseUrl);
  const done = Promise.withResolvers<void>();
  let used = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") return new Response("Not found", { status: 404 });
    if (used || url.searchParams.get("state") !== auth.state) return new Response("Invalid authorization state", { status: 400 });
    used = true;
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      done.reject(new BeniError("oauth_denied", "Linear接続がキャンセルされました。"));
      return new Response("Authorization canceled", { status: 400 });
    }
    try {
      const tokens = await exchangeToken(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: auth.redirect, code, code_verifier: auth.verifier }));
      const client = new LinearClient({ accessToken: tokens.accessToken, signal: AbortSignal.timeout(15_000) });
      const [viewer, organization] = await Promise.all([client.viewer, client.organization]);
      await secrets.set({ ...tokens, appUserId: viewer.id, organizationId: organization.id });
      done.resolve();
      return new Response("Beni: connected. You can close this tab.", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    } catch {
      done.reject(new BeniError("oauth", "Linear接続を保存できませんでした。認証設定とOSの資格情報ストアを確認してください。"));
      return new Response("Connection failed", { status: 502 });
    }
  } });
  const timer = setTimeout(() => done.reject(new BeniError("oauth_timeout", "認証がタイムアウトしました。loginを再実行してください。")), 600_000);
  console.log("次のURLをブラウザで開いてLinearに接続してください:\n" + auth.url);
  const abort = () => done.reject(new BeniError("oauth_interrupted", "認証を中断しました。"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try { await done.promise; } finally { signal?.removeEventListener("abort", abort); clearTimeout(timer); await server.stop(true); }
}
