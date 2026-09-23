// Explicit opt-in smoke test: invokes the real Codex SDK using local authentication.
// Linear is simulated; this does not claim to verify Linear OAuth or session creation.
import { fixture, samplePlan } from "../tests/support.ts";
import { CodexAgent } from "../src/codex.ts";
import { git } from "../src/git.ts";
import { safeError } from "../src/types.ts";
import { join } from "node:path";

const agent = new CodexAgent();
// Keep this smoke test focused on real execution, verification, and local integration.
agent.analyze = async () => structuredClone(samplePlan);
const f = await fixture(agent);
f.config.taskTimeoutMs = 300_000;
try {
  await f.engine.poll(); await f.engine.idle();
  if (f.store.get("session-1")?.phase !== "awaitingApproval") throw new Error("Planning did not complete");
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  const state = f.store.get("session-1")!;
  if (state.phase !== "complete") throw new Error("Smoke execution incomplete");
  const result = Bun.spawn(["bun", "test"], { cwd: state.parentWorktree, stdout: "pipe", stderr: "pipe" });
  if (await result.exited !== 0) throw new Error("Smoke verification failed");
  if (await git(f.root, ["status", "--porcelain"])) throw new Error("Original worktree was modified");
  console.log("Real Codex execution and local integration passed. Linear was simulated.");
  console.log(`Verification project: ${f.root}`);
  console.log(`Review worktree: ${state.parentWorktree}`);
  console.log(`State database: ${join(f.config.dataDir, "state.sqlite")}`);
} catch (error) {
  console.error(safeError(error));
  console.error(`Verification files retained at: ${f.dir}`);
  process.exitCode = 1;
} finally { await f.engine.shutdown(); f.store.close(); }
