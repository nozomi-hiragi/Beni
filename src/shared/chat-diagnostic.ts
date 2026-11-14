const stages = ['preparation', 'spawn', 'initialize', 'config-probe', 'config-read', 'config-validation',
  'account', 'thread-start', 'thread-resume', 'turn-start', 'turn-completion', 'host', 'agent', 'recovery'] as const;
const reasons = ['unavailable', 'invalid-request', 'spawn-failed', 'timeout', 'connection-closed', 'rpc-rejected',
  'thread-in-use', 'unsafe-config', 'authentication', 'invalid-response', 'execution-failed', 'event-delivery-failed',
  'unconfirmed', 'recovered'] as const;
const failureCodes = ['unavailable', 'model-unavailable', 'session-missing', 'session-incompatible', 'unsupported',
  'rejected', 'execution-failed', 'compaction-unavailable', 'nothing-to-compact'] as const;
const spawnErrors = ['ENOENT', 'EACCES', 'ENOEXEC', 'EMFILE', 'ENFILE'] as const;
export const configChecks = ['mcp-server-names', 'model-provider', 'mcp-servers-disabled', 'features-disabled',
  'scoped-features', 'web-search-disabled', 'read-only-sandbox', 'workspace-network-disabled',
  'workspace-slash-tmp-excluded', 'workspace-tmpdir-excluded', 'workspace-writable-roots-empty'] as const;

export type AgentFailureCode = (typeof failureCodes)[number];
export type AgentDiagnostic = {
  stage: (typeof stages)[number];
  reason: (typeof reasons)[number];
  rpcCode?: number;
  exitCode?: number;
  signal?: number;
  spawnError?: (typeof spawnErrors)[number];
  configChecks?: readonly (typeof configChecks)[number][];
};
export type ChatDiagnostic = AgentDiagnostic & { failureCode?: AgentFailureCode };

function allowed<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseSpawnError(value: unknown): AgentDiagnostic['spawnError'] {
  if (allowed(spawnErrors, value)) return value;
}

export function parseChatDiagnostic(value: unknown): ChatDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const { stage, reason, rpcCode, exitCode, signal, failureCode } = data;
  if (!allowed(stages, stage) || !allowed(reasons, reason)) return;
  const checks = data.configChecks;
  const validChecks = reason === 'unsafe-config' && Array.isArray(checks) && checks.length <= configChecks.length
    ? configChecks.filter(check => checks.includes(check)) : [];
  const spawnError = reason === 'spawn-failed' ? parseSpawnError(data.spawnError) : undefined;
  return {
    stage, reason,
    ...(allowed(failureCodes, failureCode) ? { failureCode } : {}),
    ...(integerInRange(rpcCode, -2147483648, 2147483647) ? { rpcCode } : {}),
    ...(integerInRange(exitCode, 0, 255) ? { exitCode } : {}),
    ...(integerInRange(signal, 1, 64) ? { signal } : {}),
    ...(spawnError ? { spawnError } : {}),
    ...(validChecks.length ? { configChecks: validChecks } : {}),
  };
}
