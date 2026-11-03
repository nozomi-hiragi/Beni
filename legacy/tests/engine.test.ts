import { afterEach, expect, test } from "bun:test";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, FakeAgent, samplePlan } from "./support.ts";
import { git } from "../src/git.ts";
import { Store } from "../src/store.ts";
import { validateSteps } from "../src/codex.ts";
import type { Task } from "../src/types.ts";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(agent = new FakeAgent()) { const f = await fixture(agent); fixtures.push(f); return f; }
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.engine.shutdown(); f.store.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("approval gates writes; dependencies merge into one local review branch", async () => {
  const f = await setup();
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")?.phase).toBe("awaitingApproval");
  expect((f.agent as FakeAgent).executions).toBe(0);
  expect(await git(f.root, ["branch", "--list"])).toBe("* main");
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  const state = f.store.get("session-1")!;
  expect(state.phase).toBe("complete");
  expect(state.tasks.map(t => t.status)).toEqual(["done", "done"]);
  expect(await readFile(join(state.parentWorktree!, "add.txt"), "utf8")).toBe(samplePlan.steps[0]!.description);
  expect(await readFile(join(state.parentWorktree!, "test.txt"), "utf8")).toBe(samplePlan.steps[1]!.description);
  expect(await git(f.root, ["branch", "--show-current"])).toBe("main");
  expect(await git(f.root, ["status", "--porcelain"])).toBe("");
  expect(f.linear.issues.get("issue-1")!.stateType).toBe("backlog");
  await f.engine.poll(); await f.engine.idle();
  expect((f.agent as FakeAgent).executions).toBe(2);
});

test("only requester can approve; stale approval is not applied to a revision", async () => {
  const f = await setup();
  await f.engine.poll(); await f.engine.idle();
  f.linear.prompt("/approve 1", "other");
  await f.engine.poll(); await f.engine.idle();
  expect((f.agent as FakeAgent).executions).toBe(0);
  const old = f.store.get("session-1")!.tasks.map(t => t.issueId);
  f.linear.prompt("修正");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.version).toBe(2);
  expect(old.every(id => f.linear.issues.get(id)!.stateType === "canceled")).toBe(true);
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  expect((f.agent as FakeAgent).executions).toBe(0);
});

test("remote edits invalidate the approved plan before any repository writes", async () => {
  const f = await setup();
  await f.engine.poll(); await f.engine.idle();
  const task = f.store.get("session-1")!.tasks[0]!;
  f.linear.issues.get(task.issueId)!.description = "Changed scope";
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.errorCode).toBe("plan_changed");
  expect((f.agent as FakeAgent).executions).toBe(0);
});

test("stop from another participant interrupts execution and requires explicit resume", async () => {
  const began = Promise.withResolvers<void>();
  class WaitingAgent extends FakeAgent {
    override async execute(root: string, task: Task, signal: AbortSignal, onThread: (id: string) => void) {
      if (this.executions === 0) {
        this.executions++; began.resolve();
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return super.execute(root, task, signal, onThread);
    }
  }
  const f = await setup(new WaitingAgent());
  await f.engine.poll(); await f.engine.idle();
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await began.promise;
  f.linear.prompt("stop", "other", "stop");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("stopped");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("stopped");
  f.linear.prompt("再開");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("complete");
});

test("partially published plans resume with the same issue IDs", async () => {
  const f = await setup();
  const original = f.linear.saveTask.bind(f.linear);
  let fail = true;
  f.linear.saveTask = async (parent, task) => {
    if (task.key === "test" && fail) { fail = false; throw new Error("connection lost"); }
    return original(parent, task);
  };
  await f.engine.poll(); await f.engine.idle();
  const ids = f.store.get("session-1")!.tasks.map(t => t.issueId);
  expect(f.store.get("session-1")!.phase).toBe("error");
  f.linear.prompt("再開");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("awaitingApproval");
  expect(f.store.get("session-1")!.tasks.map(t => t.issueId)).toEqual(ids);
  expect(f.linear.issues.size).toBe(3);
});

test("unmapped projects and other agents are ignored", async () => {
  const f = await setup();
  f.linear.remote.appUserId = "different-agent";
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.all()).toEqual([]);
  f.linear.remote.appUserId = "agent";
  f.linear.issues.get("issue-1")!.projectId = "unmapped";
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.all()).toEqual([]);
});

test("a persisted running task becomes stopped on restart", async () => {
  const f = await setup();
  await f.engine.poll(); await f.engine.idle();
  const state = f.store.get("session-1")!;
  state.phase = "running";
  f.store.save(state);
  const reopened = new Store(join(f.config.dataDir, "state.sqlite"));
  reopened.claim();
  expect(reopened.get("session-1")!.phase).toBe("stopped");
  expect(() => f.store.claim()).toThrow("すでに起動");
  reopened.release(); reopened.close();
});

test("dependency cycles and unknown tasks are rejected", () => {
  expect(() => validateSteps([{ ...samplePlan.steps[0]!, dependsOn: ["add"] }])).toThrow("循環");
  expect(() => validateSteps([{ ...samplePlan.steps[0]!, dependsOn: ["missing"] }])).toThrow("存在しない");
});

test("approval binds to Linear's persisted Markdown normalization", async () => {
  const f = await setup();
  const save = f.linear.saveTask.bind(f.linear);
  f.linear.saveTask = async (parent, task) => {
    await save(parent, task);
    f.linear.issues.get(task.issueId)!.description += "\n";
  };
  await f.engine.poll(); await f.engine.idle();
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("complete");
});

test("timeout stops a task without completing its dependent task", async () => {
  class SlowAgent extends FakeAgent {
    override async execute(_root: string, _task: Task, signal: AbortSignal) {
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { success: true, summary: "never" };
    }
  }
  const f = await setup(new SlowAgent());
  f.config.taskTimeoutMs = 100;
  await f.engine.poll(); await f.engine.idle();
  f.linear.prompt("/approve 1");
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.get("session-1")!.phase).toBe("error");
  expect(f.store.get("session-1")!.tasks[1]!.status).toBe("pending");
});

test("same repository sessions are serialized", async () => {
  const f = await setup();
  const second = { ...f.linear.remote, id: "session-2" };
  f.linear.sessions = async () => [f.linear.remote, second];
  await f.engine.poll(); await f.engine.idle();
  await f.engine.poll(); await f.engine.idle();
  expect(f.store.all().every(s => s.phase === "awaitingApproval")).toBe(true);
});
