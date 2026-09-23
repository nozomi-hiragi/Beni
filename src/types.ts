export type Phase = "planning" | "awaitingInput" | "awaitingApproval" | "running" | "stopped" | "error" | "complete";

export interface Step {
  key: string;
  title: string;
  description: string;
  priority: number;
  dependsOn: string[];
}

export interface Task extends Step {
  issueId: string;
  status: "pending" | "running" | "committed" | "done";
  threadId?: string;
  commit?: string;
}

export interface SessionState {
  id: string;
  issueId: string;
  requesterId: string;
  root: string;
  phase: Phase;
  version: number;
  tasks: Task[];
  planHash?: string;
  approvalId?: string;
  proposalId?: string;
  proposalTime?: number;
  inputId?: string;
  parentBranch?: string;
  parentWorktree?: string;
  errorCode?: string;
  publishing?: boolean;
  retiredTaskIds?: string[];
}

export interface Activity {
  id: string;
  userId: string;
  type: string;
  body: string;
  createdAt: number;
  signal?: string;
}

export interface RemoteSession {
  id: string;
  issueId: string;
  requesterId: string;
  appUserId: string;
  updatedAt: number;
  createdAt: number;
  dismissed: boolean;
  status: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  teamId: string;
  projectId?: string;
  parentId?: string;
  creatorId?: string;
  stateType: string;
  priority: number;
  blockedBy: string[];
}

export type ActivityContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export interface LinearPort {
  appUserId: string;
  sessions(signal?: AbortSignal): Promise<RemoteSession[]>;
  activities(id: string, signal?: AbortSignal): Promise<Activity[]>;
  issue(id: string, signal?: AbortSignal): Promise<Issue>;
  context(session: RemoteSession, signal: AbortSignal): Promise<unknown>;
  resource(kind: "issue" | "comments" | "project", id: string, signal: AbortSignal): Promise<unknown>;
  emit(sessionId: string, id: string, content: ActivityContent, signal?: AbortSignal): Promise<Activity>;
  saveTask(parent: Issue, task: Task, signal: AbortSignal): Promise<void>;
  relate(tasks: Task[], signal: AbortSignal): Promise<void>;
  taskState(id: string, state: "started" | "completed" | "canceled", signal: AbortSignal): Promise<void>;
}

export interface Analysis {
  kind: "plan" | "fetch" | "question";
  message: string;
  steps: Step[];
  resources: { kind: "issue" | "comments" | "project"; id: string }[];
}

export interface AgentPort {
  analyze(root: string, context: unknown, signal: AbortSignal): Promise<Analysis>;
  interpret(message: string, version: number, signal: AbortSignal): Promise<"approve" | "resume" | "revise" | "unclear">;
  execute(root: string, task: Task, signal: AbortSignal, onThread: (id: string) => void): Promise<{ success: boolean; summary: string }>;
}

export class BeniError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Do not pass external errors through to logs: SDK errors can contain credentials,
// source text, GraphQL variables, or command output.
export function safeError(error: unknown): string {
  if (error instanceof BeniError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "処理が設定された時間上限に達しました。状態を確認して再開してください。";
  return "外部処理に失敗しました。接続と認証を確認して再開してください。";
}
