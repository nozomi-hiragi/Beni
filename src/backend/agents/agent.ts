import type { AgentAuth, AgentAvailability, AgentCommand, AgentId, AgentModel, ContextUsage, RateLimitUsage } from '../../shared/agent';
export type { AgentCommand, AgentId, AgentModel, ContextUsage, RateLimitUsage } from '../../shared/agent';

export type AgentSession = { agentId: AgentId; id: string; legacySessionId?: string };
export type AgentTarget =
  | { mode: 'new' | 'ephemeral' }
  | { mode: 'resume'; session: AgentSession };
export type AgentAccess = 'read-only' | 'workspace-write';

export type AgentStatus = {
  availability: AgentAvailability;
  auth: AgentAuth;
  models: readonly AgentModel[] | null;
  version?: string;
  executablePath?: string;
  checkedAt: string;
  accountKey?: string;
};
export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type AgentToolResult = { ok: boolean; text: string };

export type AgentRequest = {
  sendId: string;
  target: AgentTarget;
  modelId: string;
  cwd: string;
  access: AgentAccess;
  builtInTools: 'phase-default' | 'disabled';
  instructions: string;
  references: readonly string[];
  tools: readonly AgentTool[];
  resumeToolsChanged?: boolean;
  operation: { kind: 'send'; text: string } | { kind: 'command'; name: string; args: string };
};

export type AgentUsage = {
  accountKey?: string;
  kind: 'snapshot' | 'window-update';
  usage: RateLimitUsage;
};

export type AgentFailureCode = 'unavailable' | 'model-unavailable' | 'session-missing'
  | 'session-incompatible' | 'unsupported' | 'rejected' | 'execution-failed'
  | 'compaction-unavailable' | 'nothing-to-compact';
export type AgentOutcome =
  | { status: 'completed'; output?: string }
  | { status: 'interrupted' }
  | { status: 'failed'; code: AgentFailureCode }
  | { status: 'unknown' };

export type AgentToolEvent = {
  type: 'tool';
  itemId: string;
  name: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  input?: string;
  output?: string;
  targetPaths?: readonly string[];
  exitCode?: number;
};

export type AgentEvent =
  | { type: 'accepted'; session: AgentSession | null }
  | { type: 'text.started'; itemId: string }
  | { type: 'text.delta'; itemId: string; delta: string }
  | { type: 'text.completed'; itemId: string; text: string }
  | AgentToolEvent
  | { type: 'context.usage'; data: ContextUsage }
  | { type: 'usage'; data: AgentUsage };

export interface AgentHost {
  signal: AbortSignal;
  emit(event: AgentEvent): Promise<void>;
  callTool(call: { id: string; name: string; input: unknown }): Promise<AgentToolResult>;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly accessModes: readonly AgentAccess[];
  readonly supportsEmbeddedTools: boolean;
  readonly commands: readonly AgentCommand[];
  getStatus(): Promise<AgentStatus>;
  validateCommand?(command: { name: string; args: string }): boolean;
  run(request: AgentRequest, host: AgentHost): Promise<AgentOutcome>;
  getContextUsage?(request: { session: AgentSession; modelId: string; cwd: string }, signal: AbortSignal): Promise<ContextUsage | undefined>;
  getUsage?(): Promise<AgentUsage>;
}
