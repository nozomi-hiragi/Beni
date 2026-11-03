import { LinearClient, LinearError, LinearErrorType, RatelimitedLinearError, LinearDocument, type AgentActivity as SDKActivity, type Issue as SDKIssue } from "@linear/sdk";
import { Auth } from "./auth.ts";
import { BeniError, type Activity, type ActivityContent, type Issue, type LinearPort, type RemoteSession, type Task } from "./types.ts";
import { operationId } from "./store.ts";

function activity(a: SDKActivity): Activity {
  return { id: a.id, userId: a.userId ?? "", type: a.content.type, body: "body" in a.content ? a.content.body : JSON.stringify(a.content), createdAt: a.createdAt.getTime(), ...(a.signal ? { signal: a.signal } : {}) };
}

async function issueData(i: SDKIssue): Promise<Issue> {
  const state = await i.state;
  const blockedBy: string[] = [];
  let after: string | undefined;
  do {
    const page = await i.inverseRelations({ first: 50, after });
    for (const relation of page.nodes) if (relation.type === "blocks" && relation.issueId) blockedBy.push(relation.issueId);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
  } while (after);
  return { id: i.id, identifier: i.identifier, title: i.title, description: i.description ?? "", teamId: i.teamId ?? "", projectId: i.projectId, parentId: i.parentId, creatorId: i.creatorId, stateType: state?.type ?? "", priority: i.priority, blockedBy };
}

export class Linear implements LinearPort {
  public notBefore = 0;
  constructor(private auth: Auth, public appUserId: string) {}
  private async request<T>(signal: AbortSignal | undefined, fn: (client: LinearClient) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (Date.now() < this.notBefore) throw new BeniError("rate_limit", "LinearのAPI制限により待機しています。");
    try {
      const token = await this.auth.credentials(signal);
      const timeout = AbortSignal.timeout(30_000);
      const client = new LinearClient({ accessToken: token.accessToken, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return await fn(client);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof RatelimitedLinearError) {
        this.notBefore = Math.max(Date.now() + (error.retryAfter ?? 60) * 1000, error.requestsResetAt ?? 0, error.complexityResetAt ?? 0);
        throw new BeniError("rate_limit", "LinearのAPI制限により待機しています。");
      }
      if (error instanceof BeniError) throw error;
      if (error instanceof LinearError && error.type === LinearErrorType.AuthenticationError) throw new BeniError("linear_auth", "Linear認証が無効です。loginで再接続してください。");
      if (error instanceof LinearError && error.type === LinearErrorType.Forbidden) throw new BeniError("linear_permission", "Linearへのアクセスが拒否されました。アプリの対象チームと権限を確認してください。");
      if (error instanceof LinearError && error.type === LinearErrorType.InvalidInput) throw new BeniError("linear_input", "Linear APIが操作を拒否しました。対象の存在とアプリの機能設定を確認してください。");
      if (error instanceof Error && error.name === "TimeoutError") throw new BeniError("linear_timeout", "Linear APIの応答が時間上限を超えました。接続を確認してください。");
      throw new BeniError(error instanceof LinearError ? `linear_${error.type}` : "linear_network", "Linear APIに接続できません。認証・権限・接続を確認してください。");
    }
  }
  async sessions(signal?: AbortSignal): Promise<RemoteSession[]> {
    return this.request(signal, async client => {
      const result: RemoteSession[] = [];
      let after: string | undefined;
      do {
        const page = await client.agentSessions({ first: 50, after, orderBy: LinearDocument.PaginationOrderBy.UpdatedAt });
        for (const s of page.nodes) {
          if (s.appUserId === this.appUserId && s.issueId && s.creatorId) result.push({ id: s.id, issueId: s.issueId, requesterId: s.creatorId, appUserId: s.appUserId, updatedAt: s.updatedAt.getTime(), createdAt: s.createdAt.getTime(), dismissed: !!s.dismissedAt, status: s.status });
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return result;
    });
  }
  async session(id: string, signal?: AbortSignal): Promise<RemoteSession> {
    return this.request(signal, async client => {
      const s = await client.agentSession(id);
      if (s.appUserId !== this.appUserId || !s.issueId || !s.creatorId) throw new BeniError("owner", "対象外のSessionです。");
      return { id: s.id, issueId: s.issueId, requesterId: s.creatorId, appUserId: s.appUserId, updatedAt: s.updatedAt.getTime(), createdAt: s.createdAt.getTime(), dismissed: !!s.dismissedAt, status: s.status };
    });
  }
  async activities(id: string, signal?: AbortSignal): Promise<Activity[]> {
    return this.request(signal, async client => {
      const session = await client.agentSession(id);
      if (session.appUserId !== this.appUserId) throw new BeniError("owner", "別のAgentのSessionは処理できません。");
      const result: Activity[] = [];
      let after: string | undefined;
      do {
        const page = await session.activities({ first: 100, after });
        result.push(...page.nodes.map(activity));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    });
  }
  async issue(id: string, signal?: AbortSignal): Promise<Issue> {
    return this.request(signal, async c => issueData(await c.issue(id)));
  }
  async context(session: RemoteSession, signal: AbortSignal): Promise<unknown> {
    return this.request(signal, async c => {
      const s = await c.agentSession(session.id);
      const i = await c.issue(session.issueId);
      const source = await s.sourceComment;
      const comment = await s.comment;
      const team = await i.team;
      return { issue: await issueData(i), sourceComment: source?.body, comment: comment?.body, sessionContext: s.context, teamDescription: team?.description };
    });
  }
  async resource(kind: "issue" | "comments" | "project", id: string, signal: AbortSignal): Promise<unknown> {
    return this.request(signal, async c => {
      if (kind === "issue") {
        const i = await c.issue(id);
        return { ...await issueData(i), children: (await i.children({ first: 50 })).nodes.map(x => ({ id: x.id, title: x.title })) };
      }
      if (kind === "project") {
        const p = await c.project(id);
        return { id: p.id, name: p.name, description: p.description, content: p.content };
      }
      const i = await c.issue(id);
      const result: { id: string; body: string }[] = [];
      let after: string | undefined;
      do {
        const page = await i.comments({ first: 50, after });
        result.push(...page.nodes.map(x => ({ id: x.id, body: x.body })));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
      } while (after);
      return result;
    });
  }
  async emit(sessionId: string, id: string, content: ActivityContent, signal?: AbortSignal): Promise<Activity> {
    return this.request(signal, async c => {
      // A fixed ID makes a retry after an uncertain mutation result reconcilable.
      try { return activity(await c.agentActivity(id)); }
      catch (error) { if (!(error instanceof LinearError) || error.type !== LinearErrorType.InvalidInput) throw error; }
      signal?.throwIfAborted();
      const result = await c.createAgentActivity({ id, agentSessionId: sessionId, content });
      const a = await result.agentActivity;
      if (!result.success || !a) throw new BeniError("activity", "Activityの送信に失敗しました。");
      return activity(a);
    });
  }
  async saveTask(parent: Issue, task: Task, signal: AbortSignal): Promise<void> {
    return this.request(signal, async c => {
      let existing: SDKIssue | undefined;
      try { existing = await c.issue(task.issueId); }
      catch (error) { if (!(error instanceof LinearError) || error.type !== LinearErrorType.InvalidInput) throw error; }
      if (existing) {
        const e = await issueData(existing);
        if (e.creatorId !== this.appUserId || e.parentId !== parent.id || e.stateType !== "backlog") throw new BeniError("task_changed", "作成済みの未着手工程以外は変更できません。");
        signal.throwIfAborted();
        const result = await existing.update({ title: task.title, description: task.description, priority: task.priority });
        if (!result.success) throw new BeniError("task", "工程の更新に失敗しました。");
      } else {
        const states = await c.workflowStates({ filter: { team: { id: { eq: parent.teamId } }, type: { eq: "backlog" } } });
        const state = states.nodes[0];
        if (!state) throw new BeniError("backlog", "対象チームにBacklog状態がありません。");
        signal.throwIfAborted();
        const result = await c.createIssue({ id: task.issueId, teamId: parent.teamId, projectId: parent.projectId, parentId: parent.id, stateId: state.id, title: task.title, description: task.description, priority: task.priority });
        if (!result.success) throw new BeniError("task", "工程の作成に失敗しました。");
      }
    });
  }
  async relate(tasks: Task[], signal: AbortSignal): Promise<void> {
    await this.request(signal, async c => {
      for (const t of tasks) {
        for (const dep of t.dependsOn) {
          const source = tasks.find(x => x.key === dep);
          if (!source) throw new BeniError("dependency", "工程の依存関係が不正です。");
          const id = operationId("relation", source.issueId, t.issueId);
          try { await c.issueRelation(id); continue; }
          catch (error) { if (!(error instanceof LinearError) || error.type !== LinearErrorType.InvalidInput) throw error; }
          signal.throwIfAborted();
          const result = await c.createIssueRelation({ id, issueId: source.issueId, relatedIssueId: t.issueId, type: LinearDocument.IssueRelationType.Blocks });
          if (!result.success) throw new BeniError("relation", "工程の依存関係を保存できませんでした。");
        }
      }
    });
  }
  async taskState(id: string, type: "started" | "completed" | "canceled", signal: AbortSignal): Promise<void> {
    await this.request(signal, async c => {
      const i = await c.issue(id);
      if (i.creatorId !== this.appUserId) throw new BeniError("owner", "他の作成者の工程は更新できません。");
      if ((await i.state)?.type === type) return;
      if (type === "canceled" && (await i.state)?.type !== "backlog") throw new BeniError("task_changed", "開始済み工程は計画修正できません。");
      const states = await c.workflowStates({ filter: { team: { id: { eq: i.teamId } }, type: { eq: type } } });
      const state = states.nodes[0];
      if (!state) throw new BeniError("state", "必要な工程ステータスがありません。");
      signal.throwIfAborted();
      if (!(await i.update({ stateId: state.id })).success) throw new BeniError("state", "工程の状態更新に失敗しました。");
    });
  }
}
