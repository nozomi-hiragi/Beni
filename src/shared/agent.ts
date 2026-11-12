export type AgentId = string;
export const isAgentId = (value: unknown): value is AgentId =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value);

export type AgentModel = { id: string; name: string };
export type AgentAuth = 'subscription' | 'api-key' | 'other' | 'none' | 'unknown' | 'not-required';
export type AgentAvailability = 'ready' | 'not-installed' | 'unsupported-version' | 'unavailable';
export type AgentCommand = {
  name: string;
  description: string;
  kind: 'generation' | 'maintenance';
  requiresSession: boolean;
  aliases?: readonly string[];
  argumentHint?: string;
};
export type AgentInfo = {
  id: AgentId;
  name: string;
  commands: readonly AgentCommand[];
  supportsUsage: boolean;
  supportsContextUsage?: boolean;
};
export type UsageWindow = {
  label: string;
  usedPercent?: number;
  resetsAt?: number;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
};
export type RateLimitUsage = 'unknown' | { observedAt: string; windows: UsageWindow[] };
export type ContextUsage = { usedTokens: number; maxTokens: number };
export function contextUsageFromCounts(usedTokens: unknown, maxTokens: unknown): ContextUsage | undefined {
  if (typeof usedTokens === 'number' && Number.isSafeInteger(usedTokens) && usedTokens >= 0 &&
      typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) return { usedTokens, maxTokens };
}
export type AgentConnectionStatus = {
  availability: AgentAvailability;
  auth: AgentAuth;
  models: readonly AgentModel[] | null;
  version?: string;
  executablePath?: string;
  checkedAt: string;
  usage: RateLimitUsage;
};
