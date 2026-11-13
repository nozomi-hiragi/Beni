import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { constants as osConstants } from 'node:os';
import { toolResult, type EmbeddedToolResult } from '../embedded-tools';
import { codexRateLimits } from '../rate-limits';
import { contextUsageFromCounts, type ContextUsage } from '../../shared/agent';
import { parseChatDiagnostic, parseSpawnError, type AgentDiagnostic } from '../../shared/chat-diagnostic';
import type {
 Agent, AgentCommand, AgentFailureCode, AgentHost, AgentModel, AgentOutcome, AgentRequest,
 AgentSession, AgentStatus, AgentToolEvent, AgentUsage,
} from './agent';

const modelErrors = ['model_not_found', 'model_not_supported', 'model_not_available', 'unsupported_model'];
const modelRejected = (error: any) => modelErrors.includes(error?.data?.code) || modelErrors.includes(error?.code);
const toolTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput', 'webSearch', 'imageView', 'imageGeneration']);
const disabledFeatures = ['apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'hooks', 'skill_mcp_dependency_install'];
const scopedFeatures = ['shell_tool', 'code_mode_host'] as const;
type ScopedFeatures = Record<(typeof scopedFeatures)[number], boolean>;
const workspaceSandbox = {
 network_access: false,
 exclude_slash_tmp: true,
 exclude_tmpdir_env_var: true,
 writable_roots: [],
};
const now = () => new Date().toISOString();
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const encode = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
const failed = (code: AgentFailureCode, diagnostic: AgentDiagnostic): AgentOutcome => ({ status: 'failed', code, diagnostic });
const unknown = (diagnostic: AgentDiagnostic): AgentOutcome => ({ status: 'unknown', diagnostic });
const interrupted: AgentOutcome = { status: 'interrupted' };
const threadIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const rolloutName = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/;
const contextProbeTimeout = 2000;
const rolloutTailLimit = 1024 * 1024;

type Stage = AgentDiagnostic['stage'];
type RpcDetails = Omit<AgentDiagnostic, 'stage'>;

class RpcFailure extends Error {
 constructor(readonly details: RpcDetails, readonly code?: AgentFailureCode) { super('Codex RPC failed'); }
}

function rpcDiagnostic(stage: Stage, error: unknown): AgentDiagnostic {
 if (!(error instanceof RpcFailure)) return { stage, reason: 'invalid-response' };
 return parseChatDiagnostic({ ...error.details, stage: error.details.reason === 'spawn-failed' ? 'spawn' : stage })!;
}

class CodexRpc {
 private child: ChildProcessWithoutNullStreams;
 private next = 0;
 private closing = false;
 private closeFailure?: RpcFailure;
 private pending = new Map<number, {
  resumeThreadId?: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
 }>();
 readonly closed: Promise<RpcFailure>;
 onEvent: (method: string, params: any) => void = () => {};
 onToolCall: (params: any) => Promise<EmbeddedToolResult> = async () => toolResult({ error: 'Unsupported tool' }, false);

 constructor(executable: string, config?: { servers?: readonly string[]; features?: ScopedFeatures },
  private readonly requestTimeout = 15000) {
  const args = config ? [
   '-c', 'forced_login_method="chatgpt"',
   ...scopedFeatures.flatMap(name => [config.features?.[name] ? '--enable' : '--disable', name]),
   ...disabledFeatures.flatMap(name => ['--disable', name]),
   '-c', 'web_search="disabled"',
   '-c', 'sandbox_mode="read-only"',
   // Native review inherits the thread sandbox instead of receiving a turn policy.
   ...Object.entries(workspaceSandbox).flatMap(([key, value]) => ['-c', `sandbox_workspace_write.${key}=${JSON.stringify(value)}`]),
   ...(config.servers ?? []).flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]),
   'app-server',
  ] : ['app-server'];
  try { this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw new RpcFailure({ reason: 'spawn-failed', spawnError: parseSpawnError((error as NodeJS.ErrnoException)?.code) }); }
  this.child.stderr.resume();
  this.child.stdin.on('error', () => {});
  createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
  let spawnFailure: RpcFailure | undefined;
  this.child.on('error', error => {
   if (this.child.pid === undefined) {
    spawnFailure = new RpcFailure({ reason: 'spawn-failed', spawnError: parseSpawnError((error as NodeJS.ErrnoException).code) });
   }
  });
  // close follows stdout, so a final notification flushed before exit is still processed.
  this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
   this.closing = true;
   this.closeFailure = spawnFailure ?? new RpcFailure({ reason: 'connection-closed',
    exitCode: code ?? undefined, signal: signal ? osConstants.signals[signal as NodeJS.Signals] : undefined });
   for (const request of this.pending.values()) {
    clearTimeout(request.timer);
    request.reject(this.closeFailure);
   }
   this.pending.clear();
   resolve(this.closeFailure);
  }));
 }

 private receive(line: string) {
  if (this.closing) return;
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
   if (method === 'item/tool/call') {
    void this.onToolCall(params)
     .then(result => this.write({ id, result }))
     .catch(() => this.write({ id, result: toolResult({ error: 'Embedded tool failed' }, false) }));
   } else {
    this.write({ id, error: { code: -32601, message: 'Unsupported request' } });
   }
   return;
  }
  if (typeof id === 'number') {
   const request = this.pending.get(id);
   if (!request) return;
   this.pending.delete(id);
   clearTimeout(request.timer);
   const { error, result } = message;
   if (!error) {
    request.resolve(result);
    return;
   }
   const { resumeThreadId } = request;
   const missing = resumeThreadId !== undefined && (error?.data?.code === 'thread_not_found' ||
    error?.code === -32600 && error?.message === `no rollout found for thread id ${resumeThreadId}`);
   const messageText = error?.message;
   const threadInUse = resumeThreadId !== undefined && error?.code === -32600 && typeof messageText === 'string' &&
    messageText.length <= 4096 && messageText.endsWith(`thread ${resumeThreadId} already has an active writer`);
   const details: RpcDetails = { reason: threadInUse ? 'thread-in-use' : 'rpc-rejected',
    ...(Number.isInteger(error?.code) ? { rpcCode: error.code } : {}) };
   request.reject(new RpcFailure(details, threadInUse ? 'rejected' : modelRejected(error) ? 'model-unavailable' : missing ? 'session-missing' : 'rejected'));
   return;
  }
  if (typeof method === 'string') this.onEvent(method, params);
 }

 private write(message: object) {
  if (!this.closing) this.child.stdin.write(JSON.stringify(message) + '\n');
 }

 request(method: string, params: any, timeout = this.requestTimeout): Promise<any> {
  if (this.closing) return Promise.reject(this.closeFailure ?? new RpcFailure({ reason: 'connection-closed' }));
  return new Promise((resolve, reject) => {
   const id = ++this.next;
   const timer = setTimeout(() => {
    this.pending.delete(id);
    reject(new RpcFailure({ reason: 'timeout' }));
   }, timeout);
   this.pending.set(id, { resolve, reject, timer, resumeThreadId: method === 'thread/resume' ? params.threadId : undefined });
   this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
    if (error) void this.closed.then(reject);
   });
  });
 }

 async init(timeout?: number) {
  const result = await this.request('initialize', {
   clientInfo: { name: 'beni', title: 'Beni', version: '0.2.0' },
   capabilities: { experimentalApi: true },
  }, timeout);
  this.write({ method: 'initialized', params: {} });
  return result;
 }

 close() {
  if (this.closing) return this.closed;
  this.closing = true;
  this.child.kill();
  const timeout = setTimeout(() => this.child.kill('SIGKILL'), 3000);
  timeout.unref();
  return this.closed.finally(() => clearTimeout(timeout));
 }
}

async function readAccount(rpc: CodexRpc): Promise<Pick<AgentStatus, 'auth' | 'accountKey'>> {
 const { account } = await rpc.request('account/read', { refreshToken: false });
 const auth = account?.type === 'chatgpt' ? 'subscription' : account?.type === 'apiKey' ? 'api-key' : account ? 'other' : 'none';
 const accountKey = auth === 'subscription' && nonempty(account.email)
  ? createHash('sha256').update(account.email).digest('hex') : undefined;
 return { auth, ...(accountKey === undefined ? {} : { accountKey }) };
}

function usageSnapshot(params: unknown, accountKey?: string): AgentUsage {
 const windows = codexRateLimits(params);
 return { accountKey, kind: 'snapshot', usage: windows.length ? { observedAt: now(), windows } : 'unknown' };
}

function latestRolloutUsage(lines: string, modelId: string): ContextUsage | undefined {
 let turnId: string | undefined;
 let model: string | undefined;
 let usage: ContextUsage | undefined;
 let complete = false;
 for (const line of lines.split('\n')) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  const payload = record?.payload;
  if (record?.type === 'turn_context') {
   if (turnId !== undefined && payload?.turn_id === turnId) model = payload.model;
  } else if (record?.type === 'compacted') {
   // Usage recorded before Codex replaced the history no longer describes this context.
   usage = undefined;
  } else if (record?.type === 'event_msg') {
   switch (payload?.type) {
    case 'task_started':
    case 'turn_started':
     turnId = nonempty(payload.turn_id) ? payload.turn_id : undefined;
     model = undefined;
     usage = undefined;
     complete = false;
     break;
    case 'task_complete':
    case 'turn_complete':
     complete = turnId !== undefined && payload.turn_id === turnId;
     break;
    case 'turn_aborted':
    case 'thread_rolled_back':
    case 'undo_completed':
    case 'error':
     turnId = undefined;
     usage = undefined;
     break;
    case 'context_compacted':
     usage = undefined;
     break;
    case 'token_count':
     if (turnId !== undefined && !complete) {
      usage = contextUsageFromCounts(payload.info?.last_token_usage?.total_tokens, payload.info?.model_context_window);
     }
     break;
   }
  }
 }
 return complete && model === modelId ? usage : undefined;
}

async function readRolloutUsage(home: unknown, path: unknown, id: string, modelId: string, signal: AbortSignal) {
 if (!nonempty(home) || !isAbsolute(home) || !nonempty(path) || !isAbsolute(path)) return;
 const localPath = relative(home, path);
 const name = basename(localPath);
 if (!rolloutName.test(name) || name.replace(rolloutName, '') !== `${id}.jsonl` ||
     !/^(?:sessions[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}|archived_sessions)$/.test(dirname(localPath)) ||
     path !== join(home, localPath)) return;
 const root = await realpath(home);
 const canonicalPath = join(root, localPath);
 // Only a regular file at the Codex-owned location is eligible. Reject symlinks and special files.
 if (await realpath(canonicalPath) !== canonicalPath) return;
 const entry = await lstat(canonicalPath);
 if (!entry.isFile()) return;
 signal.throwIfAborted();
 const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev) return;
  const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  const head = await file.read(header, 0, header.length, 0);
  const headerEnd = header.indexOf(10);
  if (headerEnd < 0 || headerEnd >= head.bytesRead) return;
  const meta = JSON.parse(header.toString('utf8', 0, headerEnd));
  if (meta?.type !== 'session_meta' || meta.payload?.id !== id) return;
  const tail = Buffer.alloc(Math.min(stat.size, rolloutTailLimit));
  const position = stat.size - tail.length;
  const read = await file.read(tail, 0, tail.length, position);
  const after = await file.stat();
  if (read.bytesRead !== tail.length || tail.at(-1) !== 10 ||
      stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || signal.aborted) return;
  const start = position === 0 ? 0 : tail.indexOf(10) + 1;
  return latestRolloutUsage(tail.toString('utf8', start), modelId);
 } finally {
  await file.close();
 }
}

async function withRestrictedRpc(
 executable: string,
 request: AgentRequest,
 signal: AbortSignal,
 requestTimeout: number,
 run: (rpc: CodexRpc, accountKey?: string) => Promise<AgentOutcome>,
): Promise<AgentOutcome> {
 const { cwd } = request;
 const shellEnabled = request.access === 'workspace-write' && request.builtInTools === 'phase-default';
 const features = {
  shell_tool: shellEnabled,
  code_mode_host: shellEnabled || request.tools.length > 0,
 };
 let stage: Stage = 'spawn';
 let rpc: CodexRpc | undefined;
 const stopSetup = () => { void rpc?.close(); };
 signal.addEventListener('abort', stopSetup, { once: true });
 try {
  signal.throwIfAborted();
  rpc = new CodexRpc(executable, {}, requestTimeout);
  stage = 'initialize';
  await rpc.init();
  stage = 'config-probe';
  const { config: probe } = await rpc.request('config/read', { cwd });
  const servers = Object.keys(probe.mcp_servers ?? {});
  if (!servers.every(name => /^[A-Za-z0-9_-]+$/.test(name))) {
   return failed('unavailable', { stage, reason: 'unsafe-config', configChecks: ['mcp-server-names'] });
  }
  await rpc.close();
  signal.throwIfAborted();
  stage = 'spawn';
  rpc = new CodexRpc(executable, { servers, features }, requestTimeout);
  stage = 'initialize';
  await rpc.init();
  stage = 'config-read';
  const { config } = await rpc.request('config/read', { cwd });
  stage = 'config-validation';
  const workspace = config?.sandbox_workspace_write;
  const checks: Record<Exclude<NonNullable<AgentDiagnostic['configChecks']>[number], 'mcp-server-names'>, boolean> = {
   'model-provider': config?.model_provider == null || config.model_provider === 'openai',
   'mcp-servers-disabled': Object.values(config?.mcp_servers ?? {}).every((server: any) => server?.enabled === false),
   'features-disabled': disabledFeatures.every(name => config?.features?.[name] === false),
   'scoped-features': scopedFeatures.every(name => config?.features?.[name] === features[name]),
   'web-search-disabled': config?.web_search === 'disabled',
   'read-only-sandbox': config?.sandbox_mode === 'read-only',
   'workspace-network-disabled': workspace?.network_access === false,
   'workspace-slash-tmp-excluded': workspace?.exclude_slash_tmp === true,
   'workspace-tmpdir-excluded': workspace?.exclude_tmpdir_env_var === true,
   'workspace-writable-roots-empty': Array.isArray(workspace?.writable_roots) && workspace.writable_roots.length === 0,
  };
  const failedChecks = (Object.keys(checks) as (keyof typeof checks)[]).filter(check => !checks[check]);
  if (failedChecks.length) return failed('unavailable', { stage, reason: 'unsafe-config', configChecks: failedChecks });
  stage = 'account';
  const { auth, accountKey } = await readAccount(rpc);
  if (auth !== 'subscription') return failed('unavailable', { stage, reason: 'authentication' });
  signal.throwIfAborted();
  signal.removeEventListener('abort', stopSetup);
  stage = 'agent';
  return await run(rpc, accountKey);
 } catch (error) {
  if (signal.aborted) return interrupted;
  return stage === 'agent' ? unknown({ stage, reason: 'execution-failed' }) : failed('unavailable', rpcDiagnostic(stage, error));
 } finally {
  signal.removeEventListener('abort', stopSetup);
  await rpc?.close();
 }
}

function toolEvent(item: any, started: boolean): AgentToolEvent {
 const name = item.type === 'commandExecution' ? 'command' : item.tool ?? item.name ?? item.type;
 const state = started ? 'running' :
  item.status === 'completed' ? 'completed' : item.status === 'interrupted' ? 'interrupted' :
  item.status === 'failed' || item.status === 'declined' ? 'failed' : 'unknown';
 const targetPaths = [
  ...(Array.isArray(item.changes) ? item.changes.map((change: any) => change?.path) : []),
  item.arguments?.file_path, item.arguments?.path,
 ].filter((path): path is string => typeof path === 'string');
 return {
  type: 'tool', itemId: item.id, name: typeof name === 'string' ? name : item.type, state, targetPaths,
  input: encode(item.command ?? item.arguments ?? item.changes ?? null),
  output: encode(item.aggregatedOutput ?? item.contentItems ?? item.output ?? item.result ?? item.error ?? null),
  ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
 };
}

function completedTurn(turn: any, compact: boolean, compacted: boolean): AgentOutcome {
 const stage = 'turn-completion';
 if (turn.status === 'completed') return !compact || compacted ? { status: 'completed' } : unknown({ stage, reason: 'unconfirmed' });
 if (turn.status === 'interrupted') return interrupted;
 if (turn.status !== 'failed') return unknown({ stage, reason: 'invalid-response' });
 const diagnostic = parseChatDiagnostic({ stage, reason: 'execution-failed', rpcCode: turn.error?.code })!;
 if (compact && turn.error?.code === 'COMPACTION_UNAVAILABLE') return failed('compaction-unavailable', diagnostic);
 if (compact && turn.error?.code === 'COMPACTION_NOT_NEEDED') return failed('nothing-to-compact', diagnostic);
 return failed(modelRejected(turn.error) ? 'model-unavailable' : 'execution-failed', diagnostic);
}

async function runTurn(rpc: CodexRpc, request: AgentRequest, host: AgentHost, accountKey?: string): Promise<AgentOutcome> {
 const { access, cwd, instructions, modelId, operation, target, tools } = request;
 const name = operation.kind === 'command' ? operation.name : undefined;
 const args = operation.kind === 'command' ? operation.args.trim() : '';
 const compact = name === 'compact';
 const review = name === 'review';
 let dispatched = false;
 let acknowledged = false;
 const threadStage = target.mode === 'resume' ? 'thread-resume' : 'thread-start';
 let threadId: string | undefined;
 let turnId: string | undefined;
 let session: AgentSession | null = null;
 let compacted = false;
 let compactingItem: string | undefined;
 let contextUsage: ContextUsage | undefined;
 let outcome: AgentOutcome | undefined;
 let queue = Promise.resolve();
 const result = Promise.withResolvers<AgentOutcome>();
 const accepted = Promise.withResolvers<boolean>();
 const registeredTools = new Set(tools.map(tool => tool.name));
 const reviewMessages = new Map<string, { text: string; complete: boolean }>();
 let reviewCompleted = false;
 let completionTimer: ReturnType<typeof setTimeout> | undefined;
 let interruptTimer: ReturnType<typeof setTimeout> | undefined;
 let interruptSent = false;

 const finish = (value: AgentOutcome) => {
  if (outcome) return;
  outcome = value;
  accepted.resolve(false);
  result.resolve(value);
 };
 const enqueue = (job: () => Promise<void>) => {
  queue = queue.then(async () => { if (!outcome) await job(); })
   .catch(() => finish(unknown({ stage: 'host', reason: 'event-delivery-failed' })));
  return queue;
 };
 const interrupt = () => {
  if (outcome || interruptSent) return;
  if (!dispatched) {
   finish(interrupted);
   void rpc.close();
  } else if (turnId && threadId) {
   interruptSent = true;
   interruptTimer = setTimeout(() => finish(unknown({ stage: 'turn-completion', reason: 'timeout' })), 15000);
   // Completion is authoritative even if the interrupt request itself fails.
   void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  } else if (acknowledged && compact) {
   finish(unknown({ stage: 'turn-completion', reason: 'unconfirmed' }));
  }
 };
 const accept = () => {
  enqueue(async () => { await host.emit({ type: 'accepted', session }); });
  accepted.resolve(true);
  if (host.signal.aborted) interrupt();
 };

 // Keep wire order for notifications and tool calls, even before the start response.
 // A separate queue allows acceptance to be published before draining early activity.
 let events = Promise.resolve();
 const enqueueEvent = (job: () => Promise<void>) => {
  events = events.then(async () => {
   if (await accepted.promise && !outcome) await enqueue(job);
  });
  return events;
 };

 rpc.onEvent = (method, params) => {
  if (outcome) return;
  if (method === 'account/rateLimits/updated') {
   const data = usageSnapshot(params, accountKey);
   const emit = () => host.emit({ type: 'usage', data });
   if (data.usage !== 'unknown') {
    if (turnId) enqueueEvent(emit);
    else enqueue(emit);
   }
   return;
  }
  if (!dispatched || params?.threadId !== threadId) return;
  if (compact && method === 'turn/started' && !turnId && nonempty(params.turn?.id)) {
   turnId = params.turn.id;
   if (acknowledged) accept();
  }
  enqueueEvent(async () => {
   if (method === 'turn/completed' && params.turn?.id === turnId &&
    (params.turnId === undefined || params.turnId === turnId)) {
    const value = completedTurn(params.turn, compact, compacted);
    if (value.status === 'completed' && session && contextUsage) {
     await host.emit({ type: 'context.usage', data: contextUsage });
    }
    finish(value);
    return;
   }
   if (params.turnId !== turnId) return;
   const item = params.item;
   if (method === 'thread/tokenUsage/updated') {
    if (!compactingItem && (!compact || compacted)) {
     contextUsage = contextUsageFromCounts(params.tokenUsage?.last?.totalTokens, params.tokenUsage?.modelContextWindow);
    }
    return;
   }
   if (item?.type === 'contextCompaction' && nonempty(item.id)) {
    if (method === 'item/started') {
     compactingItem = item.id;
     contextUsage = undefined;
    } else if (method === 'item/completed' && (!compactingItem || compactingItem === item.id)) {
     compactingItem = undefined;
     compacted = true;
     // Earlier reports can include the compaction request's input, rather than the new context.
     contextUsage = undefined;
    }
    return;
   }
   if (compact) return;
   if (method === 'item/agentMessage/delta' && nonempty(params.itemId) && typeof params.delta === 'string') {
    if (review) {
     const previous = reviewMessages.get(params.itemId);
     if (previous?.complete) return;
     const text = (previous?.text ?? '') + params.delta;
     if (text.length <= 1048576) reviewMessages.set(params.itemId, { text, complete: false });
    }
    await host.emit({ type: 'text.delta', itemId: params.itemId, delta: params.delta });
    return;
   }
   if ((method !== 'item/started' && method !== 'item/completed') || !nonempty(item?.id)) return;
   const started = method === 'item/started';
   if (item.type === 'agentMessage') {
    if (started) await host.emit({ type: 'text.started', itemId: item.id });
    else if (typeof item.text === 'string') {
     if (review) {
      const previous = reviewMessages.get(item.id);
      if (previous?.complete && previous.text === item.text) return;
      reviewMessages.set(item.id, { text: item.text, complete: true });
     }
     await host.emit({ type: 'text.completed', itemId: item.id, text: item.text });
    }
   } else if (review && !started && item.type === 'exitedReviewMode' && typeof item.review === 'string' && !reviewCompleted) {
    reviewCompleted = true;
    const streamed = [...reviewMessages].find(([, message]) => message.text === item.review);
    if (!streamed?.[1].complete) {
     const itemId = streamed?.[0] ?? item.id;
     reviewMessages.set(itemId, { text: item.review, complete: true });
     await host.emit({ type: 'text.completed', itemId, text: item.review });
    }
   } else if (toolTypes.has(item.type)) {
    await host.emit(toolEvent(item, started));
   }
  });
 };
 rpc.onToolCall = async params => {
  let reply = toolResult({ error: 'Unsupported tool' }, false);
  if (!dispatched || outcome || compact || params?.threadId !== threadId ||
   params.namespace != null || !nonempty(params.turnId) ||
   !nonempty(params.callId) || !registeredTools.has(params.tool)) return reply;
  await enqueueEvent(async () => {
   if (params.turnId !== turnId || host.signal.aborted) return;
   try {
    const { ok, text } = await host.callTool({ id: params.callId, name: params.tool, input: params.arguments });
    reply = { success: ok, contentItems: [{ type: 'inputText', text }] };
   } catch {
    reply = toolResult({ error: 'Embedded tool failed' }, false);
   }
  });
  return reply;
 };
 void rpc.closed.then(async error => {
  if (!acknowledged) return; // The pending request reports the closure at its own stage.
  if (turnId) await events;
  finish(unknown(rpcDiagnostic('turn-completion', error)));
 });
 host.signal.addEventListener('abort', interrupt, { once: true });

 try {
  host.signal.throwIfAborted();
  const options = {
   cwd, model: modelId, approvalPolicy: 'never', sandbox: access,
   ...(instructions ? { developerInstructions: instructions } : {}),
  };
  const opened = target.mode === 'resume'
   ? await rpc.request('thread/resume', { ...options, threadId: target.session.id, excludeTurns: true })
   : await rpc.request('thread/start', {
    ...options, ...(target.mode === 'ephemeral' ? { ephemeral: true } : {}),
    ...(tools.length ? { dynamicTools: tools.map(tool => ({ ...tool, type: 'function' })) } : {}),
   });
  threadId = opened?.thread?.id;
  if (!nonempty(threadId) || target.mode === 'resume' && threadId !== target.session.id) {
   return failed('unavailable', { stage: threadStage, reason: 'invalid-response' });
  }
  if (target.mode === 'ephemeral' && opened.thread.ephemeral !== true) {
   return failed('unsupported', { stage: threadStage, reason: 'invalid-response' });
  }
  if (target.mode !== 'ephemeral') {
   const legacySessionId = opened.thread.sessionId ?? (target.mode === 'resume' ? target.session.legacySessionId : undefined);
   session = { agentId: 'codex', id: threadId, ...(nonempty(legacySessionId) ? { legacySessionId } : {}) };
  }
  if (outcome) return outcome;
  dispatched = true;
  let response;
  if (compact) {
   completionTimer = setTimeout(() => finish(unknown({ stage: 'turn-completion', reason: 'timeout' })), 60000);
   response = await rpc.request('thread/compact/start', { threadId });
  } else if (review) {
   response = await rpc.request('review/start', {
    threadId, delivery: 'inline',
    target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' },
   });
   if (response?.reviewThreadId !== undefined && response.reviewThreadId !== threadId) {
    return unknown({ stage: 'turn-start', reason: 'invalid-response' });
   }
  } else {
   const recap = '会話のここまでの目的、決定事項、未解決事項、次の作業を簡潔に日本語で要約してください。';
   const text = operation.kind === 'send' ? operation.text : recap + (args ? '\n' + args : '');
   response = await rpc.request('turn/start', {
    threadId, model: modelId, cwd, approvalPolicy: 'never',
    sandboxPolicy: access === 'workspace-write'
     ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
     : { type: 'readOnly', networkAccess: false },
    input: [text, ...request.references].map(text => ({ type: 'text', text, text_elements: [] })),
   });
  }
  const responseTurn = response?.turn?.id;
  if ((!compact || responseTurn !== undefined) && (!nonempty(responseTurn) || turnId && turnId !== responseTurn)) {
   return unknown({ stage: 'turn-start', reason: 'invalid-response' });
  }
  turnId ??= responseTurn;
  acknowledged = true;
  if (!outcome && turnId) accept();
  else if (host.signal.aborted) interrupt();
  return await result.promise;
 } catch (error) {
  if (outcome) return outcome;
  if (!dispatched && host.signal.aborted) return interrupted;
  const diagnostic = rpcDiagnostic(dispatched ? 'turn-start' : threadStage, error);
  if (error instanceof RpcFailure && error.code) return failed(error.code, diagnostic);
  return dispatched ? unknown(diagnostic) : failed('unavailable', diagnostic);
 } finally {
  host.signal.removeEventListener('abort', interrupt);
  clearTimeout(completionTimer);
  clearTimeout(interruptTimer);
  accepted.resolve(false);
  await events;
  await queue;
 }
}

export class CodexAgent implements Agent {
 readonly id = 'codex';
 readonly name = 'Codex';
 readonly accessModes = ['read-only', 'workspace-write'] as const;
 readonly supportsEmbeddedTools = true;
 readonly commands: readonly AgentCommand[] = [
  { name: 'compact', description: '会話を圧縮', kind: 'maintenance', requiresSession: true },
  { name: 'review', description: '変更をレビュー', kind: 'generation', requiresSession: false, argumentHint: '[対象]' },
  { name: 'recap', description: '会話を要約', kind: 'generation', requiresSession: false },
 ];

 constructor(private readonly executable: () => string | null = () => Bun.which('codex'),
  private readonly requestTimeout = 15000) {}

 async getStatus(): Promise<AgentStatus> {
  const executable = this.executable();
  const status: AgentStatus = { availability: 'not-installed', auth: 'unknown', models: null, checkedAt: now() };
  if (!executable) return status;
  status.executablePath = executable;
  status.availability = 'unavailable';
  const version = await new Promise<string | undefined>(resolve => {
   execFile(executable, ['--version'], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
    resolve(!error ? stdout.match(/^codex-cli\s+([\w.+-]+)/m)?.[1] : undefined);
   });
  });
  if (version !== undefined) status.version = version;
  const rpc = new CodexRpc(executable);
  try {
   await rpc.init();
   Object.assign(status, await readAccount(rpc));
   const models: AgentModel[] = [];
   const seen = new Set<string>();
   let cursor: string | null = null;
   do {
    const page = await rpc.request('model/list', { cursor });
    for (const model of page.data ?? []) {
     if (nonempty(model?.model)) models.push({ id: model.model, name: typeof model.displayName === 'string' ? model.displayName : model.model });
    }
    cursor = nonempty(page.nextCursor) ? page.nextCursor : null;
    if (cursor) {
     if (seen.has(cursor)) throw Error('Repeated model cursor');
     seen.add(cursor);
    }
   } while (cursor);
   status.models = models;
   if (status.auth === 'subscription') status.availability = 'ready';
  } catch { /* Connection or model discovery failed. */ }
  finally { await rpc.close(); }
  return status;
 }

 async getUsage(): Promise<AgentUsage> {
  const executable = this.executable();
  if (!executable) return usageSnapshot(undefined);
  const rpc = new CodexRpc(executable);
  let accountKey: string | undefined;
  try {
   await rpc.init();
   const account = await readAccount(rpc);
   accountKey = account.accountKey;
   if (account.auth === 'subscription') {
    return usageSnapshot(await rpc.request('account/rateLimits/read', undefined, 5000), accountKey);
   }
  } catch { /* Keep the same account's last known usage if refreshing failed. */ }
  finally { await rpc.close(); }
  return usageSnapshot(undefined, accountKey);
 }

 async getContextUsage({ session, modelId }: Pick<AgentRequest, 'cwd' | 'modelId'> & { session: AgentSession },
  signal: AbortSignal): Promise<ContextUsage | undefined> {
  if (session.agentId !== this.id || !threadIdPattern.test(session.id) || signal.aborted) return;
  const executable = this.executable();
  if (!executable) return;
  const rpc = new CodexRpc(executable, {});
  const stop = () => { void rpc.close(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
   const initialized = await rpc.init(contextProbeTimeout);
   // A resume can load and persist thread state. Read only the path and model metadata here.
   const { thread } = await rpc.request('thread/read', { threadId: session.id, includeTurns: false }, contextProbeTimeout);
   if (thread?.id !== session.id || thread.model !== modelId || thread.ephemeral !== false ||
       thread.status?.type === 'active') return;
   return await readRolloutUsage(initialized?.codexHome, thread.path, session.id, modelId, signal);
  } catch { /* This CLI version or thread has no usable local measurement. */ }
  finally {
   signal.removeEventListener('abort', stop);
   await rpc.close();
  }
 }

 async run(request: AgentRequest, host: AgentHost): Promise<AgentOutcome> {
  if (host.signal.aborted) return interrupted;
  const invalidRequest = { stage: 'preparation', reason: 'invalid-request' } as const;
  if (!this.accessModes.includes(request.access)) return failed('unsupported', invalidRequest);
  const { target, operation } = request;
  const compact = operation.kind === 'command' && operation.name === 'compact';
  if (operation.kind === 'command') {
   if (!this.commands.some(command => command.name === operation.name)) return failed('unsupported', invalidRequest);
   if (compact && (operation.args.trim() || target.mode !== 'resume')) return failed('rejected', invalidRequest);
  }
  if (target.mode === 'resume' && (target.session.agentId !== this.id || !nonempty(target.session.id) ||
   !compact && request.resumeToolsChanged)) return failed('session-incompatible', invalidRequest);
  let executable: string | null;
  try {
   executable = this.executable();
  } catch {
   return failed('unavailable', { stage: 'spawn', reason: 'spawn-failed' });
  }
  if (!executable) return failed('unavailable', { stage: 'spawn', reason: 'unavailable' });
  return withRestrictedRpc(executable, request, host.signal, this.requestTimeout, (rpc, accountKey) => runTurn(rpc, request, host, accountKey));
 }
}
