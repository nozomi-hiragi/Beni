import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { createAuthorization } from "../src/auth.ts";
import { safeError } from "../src/types.ts";
import { Store } from "../src/store.ts";
import { webhookHandler } from "../src/webhook.ts";

test("configuration supports a root argument and validates bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beni-config-"));
  try {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ clientId: "example", projectId: "project", publicBaseUrl: "https://example.invalid", maxConcurrent: 3 }));
    const loaded = await loadConfig(file, dir);
    expect(loaded.maxConcurrent).toBe(3);
    expect(loaded.publicBaseUrl).toBe("https://example.invalid");
    await writeFile(file, JSON.stringify({ clientId: "example", projectId: "project", publicBaseUrl: "https://example.invalid", pollIntervalMs: 1 }));
    expect(loadConfig(file, dir)).rejects.toThrow("設定ファイル");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("OAuth uses app actor, PKCE, random state, and a tunnel callback", () => {
  const a = createAuthorization("example", "https://example.invalid");
  const b = createAuthorization("example", "https://example.invalid");
  const url = new URL(a.url);
  expect(a.state).not.toBe(b.state);
  expect(a.verifier).not.toBe(b.verifier);
  expect(url.searchParams.get("actor")).toBe("app");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("redirect_uri")).toBe("https://example.invalid/oauth/callback");
  expect(url.searchParams.has("client_secret")).toBe(false);
});

test("external errors do not expose secret-bearing messages", () => {
  expect(safeError(new Error("private-credential-example"))).not.toContain("private-credential-example");
});

test("webhook HMAC accepts a valid Linear signature", async () => {
  const store = new Store(":memory:");
  const secret = "test-webhook-secret";
  let woke = false;
  const handler = webhookHandler(secret, { organizationId: "org", appUserId: "app", clientId: "client" }, store, () => { woke = true; });
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org",
    appUserId: "app",
    oauthClientId: "client",
    webhookId: "wh-1",
    webhookTimestamp: Date.now(),
    agentSession: { id: "session-1" },
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await handler(new Request("http://127.0.0.1/webhooks/linear", {
    method: "POST",
    headers: { "Linear-Signature": signature, "Linear-Delivery": "delivery-1", "Content-Type": "application/json" },
    body,
  }));
  expect(response.status).toBe(200);
  expect(store.pendingWebhooks()).toEqual([{ id: "wh-1:delivery-1", session: "session-1" }]);
  await new Promise(r => setTimeout(r, 0));
  expect(woke).toBe(true);
  const bad = await handler(new Request("http://127.0.0.1/webhooks/linear", {
    method: "POST",
    headers: { "Linear-Signature": "0".repeat(64), "Linear-Delivery": "delivery-2", "Content-Type": "application/json" },
    body,
  }));
  expect(bad.status).toBe(401);
  store.close();
});
