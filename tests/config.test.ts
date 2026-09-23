import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createAuthorization } from "../src/auth.ts";
import { safeError } from "../src/types.ts";

test("configuration supports a root argument and validates bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beni-config-"));
  try {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify({ clientId: "example", projectId: "project", publicBaseUrl: "https://example.invalid", maxConcurrent: 3 }));
    expect((await loadConfig(file, dir)).maxConcurrent).toBe(3);
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
