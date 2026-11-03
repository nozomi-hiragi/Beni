import { BeniError, safeError, type Activity, type AgentPort, type LinearPort, type RemoteSession, type SessionState, type Task } from "./types.ts";
import { Store, operationId, planHash } from "./store.ts";
import { Workspace } from "./git.ts";
import { validateSteps } from "./codex.ts";
import type { Config } from "./config.ts";

interface Job { state: SessionState; controller: AbortController; done: Promise<void> }

export class Engine {
  private jobs = new Map<string, Job>();
  private snapshots = new Map<string, { session: RemoteSession; activities: Activity[] }>();
  private closing = false;
  private paused = false;
  constructor(private config: Config, private store: Store, private linear: LinearPort, private agent: AgentPort, private workspace: Workspace, private log: (message: string) => void = console.log) {}

  async poll(signal?: AbortSignal): Promise<void> {
    if (this.closing) return;
    const sessions = await this.linear.sessions(signal);
    await this.receive(sessions, signal);
  }

  async receive(sessions: RemoteSession[], signal?: AbortSignal): Promise<void> {
    if (this.closing) return;
    for (const session of sessions) {
      if (session.appUserId !== this.linear.appUserId) continue;
      let state = this.jobs.get(session.id)?.state ?? this.store.get(session.id);
      if (!state) {
        if (session.dismissed || ["complete", "error"].includes(session.status)) continue;
        const issue = await this.linear.issue(session.issueId, signal);
        const target = this.config.targets.find(t => t.projectId === issue.projectId);
        if (!target) continue;
        state = { id: session.id, issueId: session.issueId, requesterId: session.requesterId, root: target.root, phase: "planning", version: 0, tasks: [] };
        this.store.save(state);
      }
      const activities = await this.linear.activities(session.id, signal);
      this.snapshots.set(session.id, { session, activities });
      const prompts = activities.filter(a => a.type === "prompt" && !this.store.seen(session.id, a.id));
      const stop = prompts.findLast(a => a.signal === "stop" || /^\s*(?:\/stop|stop|停止)\s*$/i.test(a.body));
      if (session.dismissed || stop) {
        state.phase = "stopped";
        state.errorCode = "stopped";
        this.store.save(state);
        this.jobs.get(session.id)?.controller.abort();
        if (stop) for (const a of prompts) if (a.createdAt <= stop.createdAt) this.store.mark(session.id, a.id);
        // A stopped job sends its final notice after its subprocess has exited.
        if (!this.jobs.has(session.id)) await this.notice(state, `stop-${stop?.id ?? "dismissed"}`, "response", "停止しました。再開する場合は依頼者が「再開」と送信してください。", signal);
        continue;
      }
    }
    this.paused = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.closing || this.paused) return;
    for (const { session, activities } of this.snapshots.values()) {
      if (this.jobs.size >= this.config.maxConcurrent) break;
      if (this.jobs.has(session.id) || session.dismissed) continue;
      const state = this.store.get(session.id);
      if (!state || [...this.jobs.values()].some(j => j.state.root === state.root)) continue;
      for (const a of activities) if (a.type === "prompt" && a.userId !== state.requesterId) this.store.mark(session.id, a.id);
      const input = activities.find(a => a.type === "prompt" && !this.store.seen(session.id, a.id));
      if (!input && state.phase !== "planning" && state.phase !== "running") continue;
      if (input && input.userId !== state.requesterId) {
        this.store.mark(state.id, input.id);
        // Only the requester may approve, change the plan, or resume.
        continue;
      }
      const controller = new AbortController();
      const job: Job = { state, controller, done: Promise.resolve() };
      this.jobs.set(state.id, job);
      job.done = this.process(state, session, activities, input, controller.signal)
        .catch(async error => {
          if (controller.signal.aborted) {
            state.phase = "stopped";
            state.errorCode = "stopped";
          } else {
            state.phase = "error";
            state.errorCode = error instanceof BeniError ? error.code : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "external";
          }
          this.store.save(state);
          this.log(`${state.phase}: ${controller.signal.aborted ? "作業を停止しました。" : safeError(error)}`);
          try {
            await this.notice(state, `failure-${state.inputId ?? "initial"}-${state.version}-${state.errorCode}`, controller.signal.aborted ? "response" : "error", controller.signal.aborted ? "作業を停止しました。変更は保持しています。依頼者の再開指示を待ちます。" : safeError(error));
          } catch { this.log("結果をLinearへ送信できませんでした。ローカル状態は保存済みです。"); }
        })
        .finally(() => { this.jobs.delete(state.id); this.schedule(); });
    }
  }

  private async notice(state: SessionState, key: string, type: "thought" | "elicitation" | "response" | "error", body: string, signal?: AbortSignal): Promise<Activity> {
    return this.linear.emit(state.id, operationId(state.id, key), { type, body }, signal);
  }

  private async process(state: SessionState, session: RemoteSession, history: Activity[], input: Activity | undefined, signal: AbortSignal): Promise<void> {
    if (input) {
      state.inputId = input.id;
      this.store.mark(state.id, input.id);
      this.store.save(state);
    }
    if (state.version === 0 && state.phase === "planning") {
      await this.notice(state, "received", "thought", "依頼を受け付けました。内容とリポジトリを確認し、作業計画を提案します。", signal);
      await this.plan(state, session, history, signal);
      return;
    }
    if (!input) {
      if (state.phase === "running") await this.execute(state, signal);
      else if (state.phase === "planning") await this.plan(state, session, history, signal);
      return;
    }
    let decision: "approve" | "resume" | "revise" | "unclear";
    if (input.body.trim() === `/approve ${state.version}`) decision = "approve";
    else if (/^\s*(?:\/resume|resume|再開)\s*$/i.test(input.body)) decision = "resume";
    else decision = await this.agent.interpret(input.body, state.version, AbortSignal.any([signal, AbortSignal.timeout(this.config.taskTimeoutMs)]));

    if (decision === "approve" && state.phase === "awaitingApproval" && input.createdAt > (state.proposalTime ?? Infinity)) {
      await this.verifyPlan(state, signal);
      state.approvalId = input.id;
      state.phase = "running";
      this.store.save(state);
      await this.execute(state, signal);
    } else if (decision === "resume" && (state.phase === "stopped" || state.phase === "error")) {
      if (state.approvalId) {
        await this.verifyPlan(state, signal);
        state.phase = "running";
        this.store.save(state);
        await this.execute(state, signal);
      } else if (state.tasks.some(t => t.status !== "pending" && t.status !== "done")) {
        throw new BeniError("unapproved", "開始済み工程の承認状態を確認できません。");
      } else {
        if (state.publishing) await this.publishPlan(state, signal);
        else await this.plan(state, session, history, signal);
      }
    } else if (decision === "revise" && !["stopped", "error"].includes(state.phase)) {
      await this.plan(state, session, history, signal);
    } else {
      await this.notice(state, `clarify-${input.id}`, "elicitation", state.phase === "awaitingApproval" ? `最新の計画 v${state.version} を承認する場合は「/approve ${state.version}」、修正する場合は変更内容を送信してください。` : "停止・失敗した作業を再開する場合は「再開」と送信してください。追加変更は完了後に新しい計画として提案します。", signal);
    }
  }

  private async plan(state: SessionState, session: RemoteSession, history: Activity[], signal: AbortSignal): Promise<void> {
    state.phase = "planning";
    delete state.approvalId;
    this.store.save(state);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.taskTimeoutMs)]);
    const context = await this.linear.context(session, bounded);
    const extra: unknown[] = [];
    for (let round = 0; round < this.config.maxContextRounds; round++) {
      const result = await this.agent.analyze(state.root, { context, conversation: history.filter(a => a.userId === state.requesterId || a.userId === this.linear.appUserId), previousPlan: state.tasks, additionalResources: extra }, bounded);
      if (result.kind === "fetch") {
        for (const r of result.resources) extra.push({ kind: r.kind, id: r.id, data: await this.linear.resource(r.kind, r.id, bounded) });
        continue;
      }
      if (result.kind === "question") {
        await this.notice(state, `question-${state.inputId ?? "initial"}-${round}`, "elicitation", result.message, bounded);
        state.phase = "awaitingInput";
        this.store.save(state);
        return;
      }
      validateSteps(result.steps);
      // Completed work remains immutable; a revision supersedes only our backlog tasks.
      for (const task of state.tasks) {
        if (task.status !== "pending" && task.status !== "done") throw new BeniError("running_plan", "開始済みの計画は書き換えられません。先に実行状態を確認してください。");
      }
      state.retiredTaskIds = state.tasks.filter(t => t.status === "pending").map(t => t.issueId);
      state.version++;
      const tasks: Task[] = result.steps.map(s => ({ ...s, issueId: operationId(state.id, String(state.version), s.key), status: "pending" }));
      state.tasks = tasks;
      state.planHash = planHash(tasks);
      state.publishing = true;
      this.store.save(state);
      await this.publishPlan(state, bounded);
      return;
    }
    state.phase = "awaitingInput";
    this.store.save(state);
    await this.notice(state, `limit-${state.inputId ?? "initial"}`, "elicitation", "追加情報の取得上限に達しました。対象や完了条件を補足してください。", signal);
  }

  private async publishPlan(state: SessionState, signal: AbortSignal): Promise<void> {
    const parent = await this.linear.issue(state.issueId, signal);
    for (const id of state.retiredTaskIds ?? []) await this.linear.taskState(id, "canceled", signal);
    for (const task of state.tasks) await this.linear.saveTask(parent, task, signal);
    await this.linear.relate(state.tasks, signal);
    // Linear may normalize Markdown. Bind approval to the persisted plan, not
    // the pre-normalization response from the model.
    for (const task of state.tasks) {
      const saved = await this.linear.issue(task.issueId, signal);
      task.title = saved.title;
      task.description = saved.description;
      task.priority = saved.priority;
    }
    state.planHash = planHash(state.tasks);
    this.store.save(state);
    const body = `計画 v${state.version}\n\n${state.tasks.map((t, i) => `${i + 1}. ${t.title}\n${t.description}\n優先度: ${t.priority} / 依存: ${t.dependsOn.join(", ") || "なし"}`).join("\n\n")}\n\n承認する場合は「/approve ${state.version}」と返信してください。修正内容も自由文で受け付けます。同じリポジトリの工程は順次実行し、ローカルの親ブランチへ統合します。`;
    const proposal = await this.notice(state, `plan-${state.version}`, "elicitation", body, signal);
    state.proposalId = proposal.id;
    state.proposalTime = proposal.createdAt;
    state.phase = "awaitingApproval";
    state.publishing = false;
    delete state.retiredTaskIds;
    this.store.save(state);
    this.log(`計画 v${state.version}: 承認待ち`);
  }

  private async verifyPlan(state: SessionState, signal: AbortSignal): Promise<void> {
    const remote: Task[] = [];
    for (const task of state.tasks) {
      const i = await this.linear.issue(task.issueId, signal);
      if (i.parentId !== state.issueId || i.creatorId !== this.linear.appUserId || (task.status === "pending" && i.stateType !== "backlog")) throw new BeniError("plan_changed", "工程が外部で変更されています。計画を再確認してください。");
      const dependencies = task.dependsOn.map(key => state.tasks.find(t => t.key === key)!.issueId).sort();
      if (JSON.stringify([...i.blockedBy].sort()) !== JSON.stringify(dependencies)) throw new BeniError("plan_changed", "工程の依存関係が変更されています。計画を再確認してください。");
      remote.push({ ...task, title: i.title, description: i.description, priority: i.priority });
    }
    if (!state.planHash || planHash(remote) !== state.planHash) throw new BeniError("plan_changed", "提案後に工程の内容が変更されています。元の計画を確認してください。");
  }

  private async execute(state: SessionState, signal: AbortSignal): Promise<void> {
    if (!state.approvalId) throw new BeniError("approval", "実行には計画の承認が必要です。");
    const save = () => this.store.save(state);
    await this.workspace.parent(state, save, signal);
    while (state.tasks.some(t => t.status !== "done")) {
      signal.throwIfAborted();
      const task = state.tasks.filter(t => t.status !== "done" && t.dependsOn.every(d => state.tasks.some(x => x.key === d && x.status === "done"))).sort((a, b) => a.priority - b.priority)[0];
      if (!task) throw new BeniError("dependency", "実行可能な工程がありません。");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.config.taskTimeoutMs)]);
      await this.verifyPlan(state, bounded);
      await this.linear.emit(state.id, operationId(state.id, task.issueId, "start"), { type: "action", action: "工程を実行", parameter: task.title }, bounded);
      if (task.status !== "committed") {
        task.status = "running";
        save();
        await this.linear.taskState(task.issueId, "started", bounded);
        const path = await this.workspace.task(state, task, bounded);
        const result = await this.agent.execute(path, task, bounded, id => { task.threadId = id; save(); });
        bounded.throwIfAborted();
        if (!result.success) throw new BeniError("task_incomplete", "工程を完了できませんでした。作業内容と追加権限の必要性を確認して再開してください。");
        task.commit = await this.workspace.commit(path, task, bounded);
        task.status = "committed";
        save();
      }
      await this.workspace.merge(state, task, bounded);
      await this.linear.taskState(task.issueId, "completed", bounded);
      task.status = "done";
      save();
      await this.linear.emit(state.id, operationId(state.id, task.issueId, "done"), { type: "action", action: "工程を完了", parameter: task.title, result: "検証済みの変更をローカル親ブランチへ統合しました。" }, bounded);
    }
    await this.notice(state, `complete-${state.version}`, "response", `すべての工程が完了しました。ローカルブランチ ${state.parentBranch} をレビューしてください。親イシューの完了判断はユーザーに委ねます。`, signal);
    state.phase = "complete";
    this.store.save(state);
    this.log("完了: 親ブランチのレビュー待ち");
  }

  async pause(): Promise<void> {
    this.paused = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(j => j.done));
  }
  async shutdown(): Promise<void> { this.closing = true; await this.pause(); }
  async idle(): Promise<void> { while (this.jobs.size) await Promise.all([...this.jobs.values()].map(j => j.done)); }
}
