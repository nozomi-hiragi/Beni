import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Activity, ActivityContent, AgentPort, Analysis, Issue, LinearPort, RemoteSession, Task } from "../src/types.ts";
import type { Config } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { Workspace } from "../src/git.ts";
import { Engine } from "../src/engine.ts";

export const samplePlan: Analysis = { kind: "plan", message: "計画", resources: [], steps: [
  { key: "add", title: "加算関数を実装する", description: "math.tsにexport function add(a: number, b: number): numberを実装する。正数と負数で検証する。", priority: 2, dependsOn: [] },
  { key: "test", title: "加算関数のテストを追加する", description: "math.test.tsにBunのテストを追加し、bun testが成功することを確認する。", priority: 3, dependsOn: ["add"] },
] };

export class FakeLinear implements LinearPort {
  appUserId = "agent";
  remote: RemoteSession = { id: "session-1", issueId: "issue-1", requesterId: "requester", appUserId: "agent", updatedAt: 1, createdAt: 1, dismissed: false, status: "pending" };
  history: Activity[] = [];
  issues = new Map<string, Issue>([["issue-1", { id: "issue-1", identifier: "DEMO-1", title: "加算関数とテストを作る", description: "確認用プロジェクトに加算関数を実装する。", teamId: "team", projectId: "project", stateType: "backlog", priority: 2, blockedBy: [] }]]);
  now = 1000;
  mutations: string[] = [];
  async sessions() { return [this.remote]; }
  async activities() { return [...this.history]; }
  async issue(id: string) { const i = this.issues.get(id); if (!i) throw new Error("not found"); return { ...i }; }
  async context() { return { issue: await this.issue("issue-1") }; }
  async resource() { return {}; }
  async emit(sessionId: string, id: string, content: ActivityContent): Promise<Activity> {
    const existing = this.history.find(a => a.id === id);
    if (existing) return existing;
    const a: Activity = { id, userId: this.appUserId, type: content.type, body: "body" in content ? content.body : content.parameter, createdAt: ++this.now };
    this.history.push(a); this.mutations.push(`emit:${content.type}`);
    return a;
  }
  async saveTask(parent: Issue, task: Task) {
    this.issues.set(task.issueId, { id: task.issueId, identifier: "DEMO-2", title: task.title, description: task.description, teamId: parent.teamId, parentId: parent.id, projectId: parent.projectId, creatorId: this.appUserId, stateType: "backlog", priority: task.priority, blockedBy: [] });
    this.mutations.push(`save:${task.issueId}`);
  }
  async relate(tasks: Task[]) {
    for (const task of tasks) this.issues.get(task.issueId)!.blockedBy = task.dependsOn.map(k => tasks.find(t => t.key === k)!.issueId);
  }
  async taskState(id: string, state: "started" | "completed" | "canceled") {
    this.issues.get(id)!.stateType = state;
    this.mutations.push(`${state}:${id}`);
  }
  prompt(body: string, userId = "requester", signal?: string): Activity {
    const a: Activity = { id: `input-${++this.now}`, type: "prompt", body, userId, createdAt: this.now, ...(signal ? { signal } : {}) };
    this.history.push(a); return a;
  }
}

export class FakeAgent implements AgentPort {
  executions = 0;
  analyses = 0;
  async analyze(): Promise<Analysis> { this.analyses++; return structuredClone(samplePlan); }
  async interpret(message: string): Promise<"approve" | "resume" | "revise" | "unclear"> {
    return message === "修正" ? "revise" : message === "承認" ? "approve" : "unclear";
  }
  async execute(root: string, task: Task, signal: AbortSignal, onThread: (id: string) => void) {
    signal.throwIfAborted(); this.executions++; onThread(`thread-${task.key}`);
    await writeFile(join(root, `${task.key}.txt`), task.description);
    return { success: true, summary: "完了" };
  }
}

export async function fixture(agent: AgentPort = new FakeAgent()) {
  const dir = await mkdtemp(join(tmpdir(), "beni-test-"));
  const root = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await writeFile(join(root, "README.md"), "# Example project\nA local verification project.\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-qm", "Initial project"]);
  const config: Config = { clientId: "example", oauthPort: 3456, publicBaseUrl: "https://example.invalid", maxConcurrent: 2, taskTimeoutMs: 30_000, maxContextRounds: 10, dataDir: join(dir, "state"), targets: [{ root, projectId: "project" }] };
  const store = new Store(join(config.dataDir, "state.sqlite"));
  const linear = new FakeLinear();
  const workspace = new Workspace(config.dataDir);
  const engine = new Engine(config, store, linear, agent, workspace, () => {});
  return { dir, root, config, store, linear, workspace, engine, agent };
}
