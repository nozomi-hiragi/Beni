import { parseArgs } from "node:util";
import { join, relative, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { Auth, Keychain, login } from "./auth.ts";
import { Store } from "./store.ts";
import { Linear } from "./linear.ts";
import { CodexAgent } from "./codex.ts";
import { Workspace } from "./git.ts";
import { Engine } from "./engine.ts";
import { BeniError, safeError } from "./types.ts";

export const help = `Beni — Linearの依頼をローカルのCodexで処理します

使い方:
  bun /path/to/beni/index.ts [run] [project-root] [--config config.json]
  bun /path/to/beni/index.ts login [--config config.json]
  bun /path/to/beni/index.ts logout [--config config.json]
  bun /path/to/beni/index.ts status [--config config.json]

project-root省略時はカレントディレクトリを使います。
設定の初期パス: XDG_CONFIG_HOME/beni/config.json または ~/.config/beni/config.json
runはフォアグラウンドで継続実行し、Ctrl+Cで安全に停止します。
OAuth接続はloginで行います。通常運転に公開HTTP受信口は不要です。
設定例と初回接続手順はREADME.mdを参照してください。`;

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, config: { type: "string", short: "c" } }, allowPositionals: true, strict: true });
  if (values.help) { console.log(help); return; }
  const commands = ["run", "login", "logout", "status"];
  const command = commands.includes(positionals[0] ?? "") ? positionals.shift()! : "run";
  if (positionals.length > 1) throw new BeniError("arguments", "引数が多すぎます。--helpを確認してください。");
  const config = await loadConfig(values.config ?? defaultConfigPath(), positionals[0] ?? process.cwd());
  const secrets = new Keychain(config.clientId);
  if (command === "login") { await login(config.clientId, config.oauthPort, secrets); console.log("Linearに接続しました。"); return; }
  const auth = new Auth(config.clientId, secrets);
  if (command === "logout") { await auth.logout(); console.log("Linearとの接続を解除しました。"); return; }
  for (const target of config.targets) {
    const inside = relative(target.root, config.dataDir);
    if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) throw new BeniError("data_directory", "dataDirは対象リポジトリの外に指定してください。");
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(config.dataDir, "state.sqlite"));
  if (command === "status") {
    const rows = store.all().map(s => ({ session: s.id, phase: s.phase, version: s.version, completed: s.tasks.filter(t => t.status === "done").length, total: s.tasks.length, branch: s.parentBranch ?? "", error: s.errorCode ?? "" }));
    console.table(rows);
    store.close();
    return;
  }
  let engine: Engine | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    store.claim();
    const credentials = await auth.credentials();
    const identity = `${credentials.organizationId}:${credentials.appUserId}`;
    if (store.meta("identity") && store.meta("identity") !== identity) throw new BeniError("identity", "保存済み状態と接続先が異なります。別のdataDirを指定してください。");
    store.setMeta("identity", identity);
    const workspace = new Workspace(config.dataDir);
    for (const target of config.targets) await workspace.validate(target.root);
    const linear = new Linear(auth, credentials.appUserId);
    engine = new Engine(config, store, linear, new CodexAgent(config.model), workspace);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    console.log(`Beniを起動しました。取得間隔: ${config.pollIntervalMs / 1000}秒。Ctrl+Cで停止します。`);
    while (!controller.signal.aborted) {
      let delay = config.pollIntervalMs;
      try { await engine.poll(controller.signal); }
      catch (error) {
        if (controller.signal.aborted) break;
        console.error(error instanceof BeniError ? `[${error.code}] ${safeError(error)}` : safeError(error));
        // If input cannot be fetched, do not continue work while stop requests are invisible.
        await engine.pause();
        delay = Math.max(delay, linear.notBefore - Date.now(), 30_000);
      }
      if (controller.signal.aborted) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, delay);
        controller.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    await engine?.shutdown();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    store.release(); store.close();
  }
}
