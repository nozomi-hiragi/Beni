import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeRejected, ClaudeRpc, ClaudeSessionMissing, claudeGenerationArgumentsAllowed, claudeSessionContextUsage, claudeStatus,
} from '../claude';
import { toolResult } from '../embedded-tools';
import { claudeRateLimit, claudeUsageReport } from '../rate-limits';
import type { Agent, AgentAccess, AgentCommand, AgentEvent, AgentFailureCode, AgentHost, AgentOutcome, AgentRequest, AgentSession, AgentStatus, AgentUsage, ContextUsage } from './agent';

function failure(code: AgentFailureCode): AgentOutcome {
  return { status: 'failed', code };
}

function finish(code: string | undefined, accepted: boolean): AgentOutcome {
  switch (code) {
    case 'model_not_found': return failure('model-unavailable');
    case 'COMPACTION_UNAVAILABLE': return failure('compaction-unavailable');
    case 'COMPACTION_NOT_NEEDED': return failure('nothing-to-compact');
    case 'COMMAND_UNAVAILABLE': return failure('unsupported');
    case 'COMPACTION_NOT_PERFORMED':
    case 'COMMAND_NOT_PERFORMED': return failure('execution-failed');
    default: return failure(accepted ? 'execution-failed' : 'rejected');
  }
}

export class ClaudeAgent implements Agent {
  readonly id = 'claude';
  readonly name = 'Claude';
  readonly accessModes: readonly AgentAccess[] = ['read-only', 'workspace-write'];
  readonly supportsEmbeddedTools = true;
  readonly commands: readonly AgentCommand[] = [
    { name: 'compact', description: '会話を圧縮', kind: 'maintenance', requiresSession: true },
    { name: 'usage', description: '使用量を表示', kind: 'maintenance', requiresSession: true, aliases: ['cost', 'stats'] },
    { name: 'code-review', description: 'コードをレビュー', kind: 'generation', requiresSession: false, aliases: ['review'], argumentHint: '[対象]' },
    { name: 'simplify', description: 'コードを簡潔にする', kind: 'generation', requiresSession: false },
    { name: 'security-review', description: '安全性をレビュー', kind: 'generation', requiresSession: false },
    { name: 'recap', description: '会話を要約', kind: 'generation', requiresSession: false },
  ];

  constructor(private readonly executable = () => Bun.which('claude')) {}

  validateCommand({ name, args }: { name: string; args: string }): boolean {
    const command = this.commands.find(command => command.name === name);
    return !!command && (command.kind === 'maintenance' ? args === '' : claudeGenerationArgumentsAllowed(name, args));
  }

  async getStatus(): Promise<AgentStatus> {
    return this.checkStatus(this.executable());
  }

  private async checkStatus(executable: string | null): Promise<AgentStatus> {
    let accountKey: string | undefined;
    const status = await claudeStatus(executable, identity => { accountKey = identity; });
    return {
      availability: !status.installed ? 'not-installed' : status.version && !status.models ? 'unsupported-version' :
        status.auth === 'claude' ? 'ready' : 'unavailable',
      auth: status.auth === 'claude' ? 'subscription' : status.auth === 'apiKey' ? 'api-key' : status.auth,
      models: status.models,
      checkedAt: status.checkedAt,
      ...(status.version ? { version: status.version } : {}),
      ...(status.path ? { executablePath: status.path } : {}),
      ...(accountKey ? { accountKey } : {}),
    };
  }

  async run(request: AgentRequest, host: AgentHost): Promise<AgentOutcome> {
    if (host.signal.aborted) return { status: 'interrupted' };
    if (!this.accessModes.includes(request.access)) return failure('unsupported');
    if (request.target.mode === 'resume' && request.target.session.agentId !== this.id) return failure('session-incompatible');
    if (request.operation.kind === 'command') {
      const { name } = request.operation;
      const command = this.commands.find(command => command.name === name);
      if (!command) return failure('unsupported');
      if (!this.validateCommand(request.operation)) return failure('rejected');
      if (command.requiresSession && request.target.mode !== 'resume') return failure('session-missing');
    }
    const executable = this.executable();
    const status = await this.checkStatus(executable);
    if (host.signal.aborted) return { status: 'interrupted' };
    if (!executable || status.availability !== 'ready') return failure('unavailable');
    if (!status.models?.some(model => model.id === request.modelId)) return failure('model-unavailable');
    return this.execute(executable, status.accountKey, request, host);
  }

  async getUsage(): Promise<AgentUsage> {
    const executable = this.executable();
    const { availability, accountKey } = await this.checkStatus(executable);
    const unknown: AgentUsage = { accountKey, kind: 'window-update', usage: 'unknown' };
    if (!executable || availability !== 'ready' || !accountKey) return unknown;
    const cwd = await mkdtemp(join(tmpdir(), 'beni-claude-usage-')).catch(() => null);
    if (!cwd) return unknown;
    try {
      const signal = new AbortController().signal;
      const request: AgentRequest = {
        sendId: randomUUID(), target: { mode: 'ephemeral' }, modelId: 'haiku', cwd, access: 'read-only',
        builtInTools: 'disabled', instructions: '', references: [], tools: [],
        operation: { kind: 'command', name: 'usage', args: '' },
      };
      const host: AgentHost = { signal, emit: async () => {}, callTool: async () => ({ ok: false, text: '' }) };
      let snapshot: AgentUsage | undefined;
      const reportOutcome = await this.execute(executable, accountKey, request, host, {
        timeoutMs: 15_000,
        onReport: report => {
          const windows = claudeUsageReport(report);
          if (windows.length) snapshot = { accountKey, kind: 'snapshot', usage: { observedAt: new Date().toISOString(), windows } };
        },
      });
      if ((await this.getStatus()).accountKey !== accountKey) return unknown;
      if (reportOutcome.status === 'completed' && snapshot) return snapshot;

      const windows = new Map<string, NonNullable<ReturnType<typeof claudeRateLimit>>>();
      await this.execute(executable, accountKey, {
        ...request, operation: { kind: 'send', text: 'Reply only with OK.' },
      }, {
        ...host,
        emit: async event => {
          if (event.type !== 'usage' || event.data.usage === 'unknown') return;
          for (const window of event.data.usage.windows) windows.set(window.label, window);
        },
      }, { timeoutMs: 15_000 });
      if (!windows.size || (await this.getStatus()).accountKey !== accountKey) return unknown;
      return { accountKey, kind: 'window-update', usage: { observedAt: new Date().toISOString(), windows: [...windows.values()] } };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async getContextUsage({ session, modelId, cwd }: { session: AgentSession; modelId: string; cwd: string }, signal: AbortSignal): Promise<ContextUsage | undefined> {
    const executable = this.executable();
    if (executable && session.agentId === this.id) return claudeSessionContextUsage(executable, session.id, modelId, cwd, signal);
  }

  private async execute(
    executable: string, accountKey: string | undefined, request: AgentRequest, host: AgentHost,
    probe?: { timeoutMs: number; onReport?: (report: unknown) => void },
  ): Promise<AgentOutcome> {
    const rpc = new ClaudeRpc(executable);
    const closed = new Promise<number | null>(resolve => { rpc.onClose = resolve; });
    const command = request.operation.kind === 'command' ? request.operation : undefined;
    const maintenance = command && this.commands.some(entry => entry.name === command.name && entry.kind === 'maintenance');
    const ephemeral = request.target.mode === 'ephemeral';
    let sessionId: string;
    let turnId: string | undefined;
    let accepted = false;
    let outcome: AgentOutcome | undefined;
    let output: string | undefined;
    let startError: unknown;
    let timedOut = false;
    let deliveryFailed = false;
    let events = Promise.resolve();
    const emit = (event: AgentEvent) => {
      events = events.then(async () => {
        if (!deliveryFailed) await host.emit(event);
      }).catch(() => {
        deliveryFailed = true;
        rpc.close();
      });
    };
    const stop = () => {
      if (turnId && !outcome) void rpc.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => {});
    };
    const timeoutMs = probe?.timeoutMs ?? (maintenance ? 60_000 : undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const target = request.target;
      const { thread } = await rpc.request(target.mode === 'resume' ? 'thread/resume' : 'thread/start', {
        ...(target.mode === 'resume' ? { threadId: target.session.id } : {}),
        cwd: request.cwd, model: request.modelId, sandbox: request.access, authoritativeText: true,
        developerInstructions: request.instructions,
        ...(request.builtInTools === 'disabled' ? { builtinTools: false } : {}),
        ...(ephemeral ? { ephemeral: true } : {}),
        dynamicTools: request.tools.map(tool => ({ ...tool, type: 'function' })),
      });
      sessionId = thread.id;
      if (host.signal.aborted) return { status: 'interrupted' };
      rpc.onAccepted = () => {
        accepted = true;
        emit({ type: 'accepted', session: ephemeral ? null : { agentId: this.id, id: sessionId, legacySessionId: sessionId } });
      };
      rpc.waitForEvents = () => events;
      rpc.onToolCall = async params => {
        await events;
        if (deliveryFailed || outcome || host.signal.aborted || !accepted || params.threadId !== sessionId || params.turnId !== turnId) {
          return toolResult({ error: 'Embedded tool request rejected or unavailable' }, false);
        }
        const result = await host.callTool({ id: params.callId, name: params.tool, input: params.arguments });
        return { contentItems: [{ type: 'inputText', text: result.text }], success: result.ok };
      };
      rpc.onEvent = (method, params) => {
        if (outcome || deliveryFailed) return;
        if (method === 'account/rateLimits/updated') {
          const window = claudeRateLimit(params);
          if (window) emit({
            type: 'usage', data: { accountKey, kind: 'window-update', usage: { observedAt: new Date().toISOString(), windows: [window] } },
          });
          return;
        }
        if (params.threadId !== sessionId) return;
        if (method === 'turn/started') {
          turnId = params.turn.id;
          if (host.signal.aborted) stop();
          return;
        }
        if (params.turnId !== turnId) return;
        if (method === 'turn/completed') {
          outcome = params.turn.status === 'completed' && accepted ? { status: 'completed', ...(output === undefined ? {} : { output }) }
            : params.turn.status === 'interrupted' ? { status: 'interrupted' }
            : params.turn.status === 'failed' ? finish(params.turn.error?.code, accepted)
            : { status: 'unknown' };
          return;
        }
        if (!accepted) return;
        if (method === 'account/usage/report') probe?.onReport?.(params.report);
        if (method === 'thread/context/usage') emit({ type: 'context.usage', data: params.usage });
        if (method === 'thread/command/output') output = params.output;
        if (maintenance) return;
        if (method === 'item/agentMessage/delta') emit({ type: 'text.delta', itemId: params.itemId, delta: params.delta });
        if (method !== 'item/started' && method !== 'item/completed') return;
        const item = params.item;
        if (item.type === 'agentMessage') {
          emit(method === 'item/started' ? { type: 'text.started', itemId: item.id } : { type: 'text.completed', itemId: item.id, text: item.text });
        } else if (item.type === 'dynamicToolCall') {
          const input = item.arguments;
          const targetPaths = [input?.file_path, input?.path].filter((path): path is string => typeof path === 'string');
          emit({
            type: 'tool', itemId: item.id, name: item.name,
            state: method === 'item/started' ? 'running' : item.status,
            input: typeof input === 'string' ? input : JSON.stringify(input),
            output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
            ...(targetPaths.length ? { targetPaths } : {}),
          });
        }
      };
      host.signal.addEventListener('abort', stop, { once: true });
      if (timeoutMs) {
        timer = setTimeout(() => { timedOut = true; rpc.close(); }, timeoutMs);
        timer.unref();
      }
      const method = maintenance ? command.name === 'compact' ? 'thread/compact/start' : 'thread/command/start' : 'turn/start';
      const params = maintenance ? { threadId: sessionId, command: command.name } : {
        threadId: sessionId,
        input: [request.operation.kind === 'send' ? request.operation.text : '', ...request.references].map(text => ({ type: 'text', text })),
        ...(command ? { command: { name: command.name, args: command.args } } : {}),
      };
      const starting = rpc.request(method, params).catch(error => {
        startError = error;
        if (!turnId) rpc.close();
      });
      const [exitCode] = await Promise.all([closed, starting]);
      await events;
      if (timedOut || deliveryFailed) return { status: 'unknown' };
      if (outcome) return maintenance && outcome.status === 'completed' && exitCode !== 0 ? { status: 'unknown' } : outcome;
      if (startError instanceof ClaudeSessionMissing) return failure('session-missing');
      if (startError instanceof ClaudeRejected) {
        return startError.interrupted ? { status: 'interrupted' } : startError.modelUnavailable ? failure('model-unavailable') : failure('rejected');
      }
      return turnId ? { status: 'unknown' } : failure('unavailable');
    } catch (error) {
      return error instanceof ClaudeRejected ? failure('rejected') : { status: 'unknown' };
    } finally {
      clearTimeout(timer);
      host.signal.removeEventListener('abort', stop);
      rpc.close();
      await closed;
    }
  }
}
