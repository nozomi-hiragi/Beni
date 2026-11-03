import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BeniError, type SessionState, type Task } from "./types.ts";
import { operationId } from "./store.ts";

const exec = promisify(execFile);
export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const r = await exec("git", ["-C", root, ...args], { signal, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return r.stdout.trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BeniError("git", "Git操作に失敗しました。作業ツリーと競合状態を確認してください。変更は保持しています。");
  }
}

export class Workspace {
  constructor(private dataDir: string) {}
  async validate(root: string): Promise<void> {
    const top = await git(root, ["rev-parse", "--show-toplevel"]);
    if (top !== root) throw new BeniError("root", "対象にはGitリポジトリのルートを指定してください。");
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  }
  async parent(state: SessionState, save: () => void, signal: AbortSignal): Promise<string> {
    if (!state.parentBranch) {
      state.parentBranch = `beni/issue-${state.issueId}`;
      state.parentWorktree = join(this.dataDir, "worktrees", operationId(state.root), state.issueId, "parent");
      save();
    }
    const path = state.parentWorktree!;
    await this.ensure(state.root, path, state.parentBranch, "HEAD", signal);
    return path;
  }
  async task(state: SessionState, task: Task, signal: AbortSignal): Promise<string> {
    if (!state.parentBranch || !state.parentWorktree) throw new BeniError("workspace", "親ブランチが未作成です。");
    const path = join(this.dataDir, "worktrees", operationId(state.root), state.issueId, task.issueId);
    await this.ensure(state.root, path, `${state.parentBranch}-task-${task.issueId}`, state.parentBranch, signal);
    return path;
  }
  private async ensure(root: string, path: string, branch: string, base: string, signal: AbortSignal): Promise<void> {
    let exists = false;
    try { await stat(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (exists) {
      if (await git(path, ["branch", "--show-current"], signal) !== branch) throw new BeniError("branch", "作業ツリーのブランチが変更されています。");
      return;
    }
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const refs = await git(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`], signal);
    if (refs.split("\n").includes(branch)) throw new BeniError("branch_exists", "作成予定のブランチがすでに存在します。既存の作業は変更しません。");
    await git(root, ["worktree", "add", "-b", branch, path, base], signal);
  }
  async commit(path: string, task: Task, signal: AbortSignal): Promise<string> {
    const status = await git(path, ["status", "--porcelain"], signal);
    if (status) {
      await git(path, ["add", "--all"], signal);
      await git(path, ["-c", "user.name=Beni", "-c", "user.email=beni@example.invalid", "commit", "-m", `Complete task ${task.issueId}`], signal);
    }
    return git(path, ["rev-parse", "HEAD"], signal);
  }
  async merge(state: SessionState, task: Task, signal: AbortSignal): Promise<void> {
    if (!state.parentWorktree || !task.commit) throw new BeniError("merge", "統合に必要な状態がありません。");
    if (await git(state.parentWorktree, ["status", "--porcelain"], signal)) throw new BeniError("dirty_parent", "親ブランチに未コミット変更があります。自動統合を停止します。");
    // Same-repository execution is serial, so successful integration must be fast-forward.
    await git(state.parentWorktree, ["merge", "--ff-only", task.commit], signal);
  }
}
