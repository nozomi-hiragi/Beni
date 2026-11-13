import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentRequest } from './agent';
import { CodexAgent } from './codex';

const fake = fileURLToPath(new URL('../test/fake-codex.ts', import.meta.url));
const agent = new CodexAgent(() => fake);
const session = { agentId: 'codex', id: 'thread-1', legacySessionId: 'session-1' };
const request: AgentRequest = {
 sendId: 'send-1', target: { mode: 'new' }, modelId: 'model-a', cwd: '/tmp',
 access: 'read-only', builtInTools: 'phase-default', instructions: '', references: [], tools: [],
 operation: { kind: 'send', text: 'hello' },
};

async function run(overrides: Partial<AgentRequest> = {}, client = agent) {
 const events: AgentEvent[] = [];
 const outcome = await client.run({ ...request, ...overrides }, {
  signal: new AbortController().signal,
  emit: async event => { events.push(event); },
  callTool: async () => { throw Error('Unexpected tool call'); },
 });
 return { events, outcome };
}

test('Codex receives an early text delta only after acceptance and supports ephemeral threads', async () => {
 expect(await agent.getStatus()).toMatchObject({
  availability: 'ready', auth: 'subscription', version: '1.2.3', models: [{ id: 'model-a', name: 'Model A' }],
 });
 const { events, outcome } = await run();
 expect(outcome).toEqual({ status: 'completed' });
 expect(events).toEqual([
  { type: 'accepted', session },
  { type: 'text.delta', itemId: 'message-1', delta: 'Hello' },
 ]);
 const ephemeral = await run({ target: { mode: 'ephemeral' } });
 expect(ephemeral.outcome).toEqual({ status: 'completed' });
 expect(ephemeral.events[0]).toEqual({ type: 'accepted', session: null });
});

test('Codex review uses the dedicated final text and reconciles a matching streamed item', async () => {
 const text = '確認した差分に指摘はありません。';
 try {
  for (const mode of ['final', 'streamed']) {
   process.env.FAKE_CODEX_REVIEW = mode;
   const { events, outcome } = await run({ operation: { kind: 'command', name: 'review', args: '' } });
   expect(outcome).toEqual({ status: 'completed' });
   const expected: AgentEvent[] = [{ type: 'accepted', session }];
   if (mode === 'streamed') expected.push({ type: 'text.delta', itemId: 'review-message', delta: text });
   expected.push({ type: 'text.completed', itemId: mode === 'streamed' ? 'review-message' : 'turn-1', text });
   expect(events).toEqual(expected);
  }
 } finally { delete process.env.FAKE_CODEX_REVIEW; }
});

test('Codex review refuses an effective configuration that allows network access', async () => {
 const review: Partial<AgentRequest> = { operation: { kind: 'command', name: 'review', args: '' } };
 expect((await run({ ...review, access: 'workspace-write' })).outcome).toEqual({ status: 'completed' });
 process.env.FAKE_CODEX_UNSAFE_SANDBOX = '1';
 try {
  for (const access of ['read-only', 'workspace-write'] as const) {
   expect(await run({ ...review, access })).toEqual({
    events: [], outcome: { status: 'failed', code: 'unavailable', diagnostic: {
     stage: 'config-validation', reason: 'unsafe-config', configChecks: ['workspace-network-disabled'],
    } },
   });
  }
 } finally { delete process.env.FAKE_CODEX_UNSAFE_SANDBOX; }
});

test('Codex enables the code mode host for embedded tools independently of the shell', async () => {
 const tools = [{ name: 'echo', description: 'Echoes text.', inputSchema: { type: 'object' } }];
 for (const [access, builtInTools, hasEmbeddedTools, shell, host] of [
  ['read-only', 'phase-default', false, false, false],
  ['read-only', 'phase-default', true, false, true],
  ['read-only', 'disabled', true, false, true],
  ['workspace-write', 'phase-default', false, true, true],
  ['workspace-write', 'disabled', false, false, false],
  ['workspace-write', 'disabled', true, false, true],
 ] as const) {
  const { events, outcome } = await run({
   access, builtInTools, tools: hasEmbeddedTools ? tools : [],
   operation: { kind: 'send', text: 'report tool features' },
  });
  expect(outcome).toEqual({ status: 'completed' });
  expect(events).toContainEqual({
   type: 'text.delta', itemId: 'message-1', delta: JSON.stringify({ shell_tool: shell, code_mode_host: host }),
  });
 }
});

test('Codex calls registered tools in the accepted turn even when the request arrived early', async () => {
 const types: string[] = [];
 process.env.FAKE_EMBEDDED_CALLS = JSON.stringify([
  { tool: 'echo', arguments: { text: 'example' } },
  { tool: 'unregistered', arguments: {} },
 ]);
 try {
  const outcome = await agent.run({
   ...request, builtInTools: 'disabled',
   tools: [{ name: 'echo', description: 'Echoes text.', inputSchema: { type: 'object' } }],
  }, {
   signal: new AbortController().signal,
   emit: async event => { types.push(event.type); },
   callTool: async call => {
    expect(call).toEqual({ id: 'embedded:0', name: 'echo', input: { text: 'example' } });
    types.push('call');
    return { ok: true, text: 'example' };
   },
  });
  expect(outcome).toEqual({ status: 'completed' });
  expect(types).toEqual(['accepted', 'tool', 'call', 'tool', 'tool', 'tool', 'text.delta']);
 } finally { delete process.env.FAKE_EMBEDDED_CALLS; }
});

test('Codex distinguishes missing sessions, reauthenticates, and confirms interruption', async () => {
 const target = { mode: 'resume', session } as const;
 expect((await run({ target, resumeToolsChanged: true })).outcome).toEqual({ status: 'failed', code: 'session-incompatible',
  diagnostic: { stage: 'preparation', reason: 'invalid-request' } });
 try {
  process.env.FAKE_CODEX_RESUME = 'missing';
  expect((await run({ target })).outcome).toEqual({ status: 'failed', code: 'session-missing',
   diagnostic: { stage: 'thread-resume', reason: 'rpc-rejected', rpcCode: -32600 } });
  process.env.FAKE_AUTH = 'apiKey';
  expect(await run()).toEqual({ events: [], outcome: { status: 'failed', code: 'unavailable',
   diagnostic: { stage: 'account', reason: 'authentication' } } });
 } finally {
  delete process.env.FAKE_CODEX_RESUME;
  delete process.env.FAKE_AUTH;
 }
 const controller = new AbortController();
 const outcome = await agent.run({ ...request, operation: { kind: 'send', text: 'wait' } }, {
  signal: controller.signal,
  emit: async event => { if (event.type === 'text.delta') controller.abort(); },
  callTool: async () => { throw Error('Unexpected tool call'); },
 });
 expect(outcome).toEqual({ status: 'interrupted' });
});

test('Codex identifies only bounded active-writer errors for the exact resumed thread', async () => {
 const target = { mode: 'resume', session } as const;
 try {
  for (const mode of ['active-writer-prefix', 'active-writer-other-thread', 'active-writer-similar',
   'active-writer-long', 'active-writer-wrong-code'] as const) {
   process.env.FAKE_CODEX_RESUME = mode;
   const result = await run({ target });
   const activeWriter = mode === 'active-writer-prefix';
   expect(result.events).toEqual([]);
   expect(result.outcome).toEqual({ status: 'failed', code: 'rejected', diagnostic: {
    stage: 'thread-resume', reason: activeWriter ? 'thread-in-use' : 'rpc-rejected',
    rpcCode: mode === 'active-writer-wrong-code' ? -32000 : -32600,
   } });
   expect(JSON.stringify(result.outcome)).not.toContain('thread-1');
   expect(JSON.stringify(result.outcome)).not.toContain('failed to resume');
  }
 } finally { delete process.env.FAKE_CODEX_RESUME; }
});

test('Codex records bounded setup diagnostics without saving stderr, RPC messages, or config values', async () => {
 const client = new CodexAgent(() => fake, 500);
 try {
  for (const [mode, diagnostic] of [
   ['initialize-close', { stage: 'initialize', reason: 'connection-closed', exitCode: 27 }],
   ['config-timeout', { stage: 'config-probe', reason: 'timeout' }],
   ['config-reject', { stage: 'config-probe', reason: 'rpc-rejected', rpcCode: -32001 }],
   ['unsafe-config', { stage: 'config-probe', reason: 'unsafe-config', configChecks: ['mcp-server-names'] }],
  ] as const) {
   process.env.FAKE_CODEX_DIAGNOSTIC = mode;
   expect(await run({}, client)).toEqual({ events: [], outcome: { status: 'failed', code: 'unavailable', diagnostic } });
  }
 } finally { delete process.env.FAKE_CODEX_DIAGNOSTIC; }
 const missing = new CodexAgent(() => `${fake}.missing`);
 expect(await run({}, missing)).toEqual({ events: [], outcome: { status: 'failed', code: 'unavailable',
  diagnostic: { stage: 'spawn', reason: 'spawn-failed', spawnError: 'ENOENT' } } });
});

test('Codex distinguishes turn rejection, disconnect and reported execution failure', async () => {
 for (const [text, outcome, accepted] of [
  ['reject model', { status: 'failed', code: 'model-unavailable', diagnostic: { stage: 'turn-start', reason: 'rpc-rejected', rpcCode: -32600 } }, false],
  ['disconnect', { status: 'unknown', diagnostic: { stage: 'turn-start', reason: 'connection-closed', exitCode: 0 } }, false],
  ['disconnect after acceptance', { status: 'unknown', diagnostic: { stage: 'turn-completion', reason: 'connection-closed', signal: 15 } }, true],
  ['fail', { status: 'failed', code: 'execution-failed', diagnostic: { stage: 'turn-completion', reason: 'execution-failed', rpcCode: -32000 } }, true],
 ] as const) {
  const result = await run({ operation: { kind: 'send', text } });
  expect(result.outcome).toEqual(outcome);
  expect(result.events.some(event => event.type === 'accepted')).toBe(accepted);
 }
});

test('Codex safely reports a failure publishing acceptance to the host', async () => {
 const outcome = await agent.run(request, {
  signal: new AbortController().signal,
  emit: async () => { throw Error('fake-private-detail'); },
  callTool: async () => { throw Error('Unexpected tool call'); },
 });
 expect(outcome).toEqual({ status: 'unknown', diagnostic: { stage: 'host', reason: 'event-delivery-failed' } });
});

test('Codex compaction waits for both the matching item and completed turn after acknowledgement', async () => {
 const options: Partial<AgentRequest> = {
  target: { mode: 'resume', session }, operation: { kind: 'command', name: 'compact', args: '' },
 };
 try {
  for (const [action, status] of [
   ['early', 'completed'], ['unrelated', 'completed'], ['missing-boundary', 'unknown'],
   ['boundary-failure', 'failed'], ['boundary-interrupt', 'interrupted'],
   ['boundary-disconnect', 'unknown'], ['disconnect-before-ack', 'unknown'],
  ] as const) {
   process.env.FAKE_CODEX_COMPACT_ACTION = action;
   const { outcome, events } = await run(options);
   expect(outcome.status).toBe(status);
   expect(events).toEqual(action === 'disconnect-before-ack' ? [] : [{ type: 'accepted', session }]);
  }
 } finally { delete process.env.FAKE_CODEX_COMPACT_ACTION; }
});

test('Codex reports only active context usage from the matching turn and session', async () => {
 try {
  process.env.FAKE_CODEX_CONTEXT = 'fresh';
  const { events, outcome } = await run();
  expect(outcome.status).toBe('completed');
  expect(events[0]).toEqual({ type: 'accepted', session });
  expect(events.filter(event => event.type === 'context.usage')).toEqual([
   { type: 'context.usage', data: { usedTokens: 22_000, maxTokens: 100_000 } },
  ]);
  process.env.FAKE_CODEX_CONTEXT = 'missing-window';
  expect((await run()).events.some(event => event.type === 'context.usage')).toBe(false);
 } finally { delete process.env.FAKE_CODEX_CONTEXT; }
});

test('Codex recovers only the latest completed context measurement through a local thread read', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'beni-codex-usage-'));
 const root = join(cwd, 'sessions', '2026', '10', '15');
 const id = '01936ef3-0000-7000-8000-000000000001';
 const path = join(root, `rollout-2026-10-15T12-00-00-${id}.jsonl`);
 const log = join(cwd, 'rpc.jsonl');
 const signal = new AbortController().signal;
 const probe = { session: { ...session, id }, modelId: 'model-a', cwd };
 const record = (type: string, payload: object) => JSON.stringify({ type, payload }) + '\n';
 const event = (type: string, payload: object = {}) => record('event_msg', { type, ...payload });
 const tokenCount = (total_tokens: number, model_context_window: number | null = 100_000) => event('token_count', {
  info: { last_token_usage: { total_tokens }, total_token_usage: { total_tokens: 330_000 }, model_context_window },
 });
 const meta = record('session_meta', { id });
 const start = event('task_started', { turn_id: 'turn-1' }) +
  record('turn_context', { turn_id: 'turn-1', model: 'model-a' });
 const complete = event('task_complete', { turn_id: 'turn-1' });
 const normal = meta + start + tokenCount(22_000) + complete;
 const compacted = meta + start + tokenCount(22_000) + record('compacted', {});
 await mkdir(root, { recursive: true });
 process.env.FAKE_CODEX_ROLLOUT_HOME = cwd;
 process.env.FAKE_CODEX_ROLLOUT_PATH = path;
 process.env.FAKE_CODEX_LOG = log;
 try {
  await writeFile(path, normal);
  expect(await agent.getContextUsage(probe, signal)).toEqual({ usedTokens: 22_000, maxTokens: 100_000 });
  expect(await readFile(path, 'utf8')).toBe(normal);
  const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(requests.map(row => row.method)).toEqual(['initialize', 'initialized', 'thread/read']);
  expect(requests.at(-1).params).toEqual({ threadId: id, includeTurns: false });
  expect(await agent.getContextUsage({ ...probe, modelId: 'model-b' }, signal)).toBeUndefined();
  const longRecord = record('response_item', { text: 'x'.repeat(1024 * 1024) });
  for (const [contents, usage] of [
   [meta + longRecord + start + tokenCount(21_000) + complete, { usedTokens: 21_000, maxTokens: 100_000 }],
   [meta + start + longRecord + tokenCount(21_000) + complete, undefined],
   [compacted + complete, undefined],
   [compacted + tokenCount(7_000) + complete, { usedTokens: 7_000, maxTokens: 100_000 }],
   [meta + start + tokenCount(22_000, null) + complete, undefined],
   [normal + event('task_started', { turn_id: 'newer-turn' }), undefined],
   [normal + '{', undefined],
   [record('session_meta', { id: 'different' }) + start + tokenCount(22_000) + complete, undefined],
  ] as const) {
   await writeFile(path, contents);
   expect(await agent.getContextUsage(probe, signal)).toEqual(usage);
  }
  await writeFile(path, normal);
  const unrelated = join(cwd, 'other.jsonl');
  await rename(path, unrelated);
  await symlink(unrelated, path);
  expect(await agent.getContextUsage(probe, signal)).toBeUndefined();
 } finally {
  delete process.env.FAKE_CODEX_ROLLOUT_HOME;
  delete process.env.FAKE_CODEX_ROLLOUT_PATH;
  delete process.env.FAKE_CODEX_LOG;
  await rm(cwd, { recursive: true, force: true });
 }
});

test('Codex compaction ignores old context usage and only reports a fresh measurement on success', async () => {
 const options: Partial<AgentRequest> = {
  target: { mode: 'resume', session }, operation: { kind: 'command', name: 'compact', args: '' },
 };
 try {
  process.env.FAKE_CODEX_CONTEXT = 'stale';
  expect((await run(options)).events).toEqual([{ type: 'accepted', session }]);
  process.env.FAKE_CODEX_CONTEXT = 'fresh';
  expect((await run(options)).events).toEqual([
   { type: 'accepted', session },
   { type: 'context.usage', data: { usedTokens: 10_000, maxTokens: 100_000 } },
  ]);
  process.env.FAKE_CODEX_COMPACT_ACTION = 'boundary-failure';
  const { events, outcome } = await run(options);
  expect(outcome.status).toBe('failed');
  expect(events).toEqual([{ type: 'accepted', session }]);
 } finally {
  delete process.env.FAKE_CODEX_CONTEXT;
  delete process.env.FAKE_CODEX_COMPACT_ACTION;
 }
});

test('Codex abort reports an unknown result when compaction was dispatched without a turn ID', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'beni-codex-compact-'));
 const log = join(cwd, 'rpc.jsonl');
 await writeFile(log, '');
 process.env.FAKE_CODEX_LOG = log;
 process.env.FAKE_CODEX_COMPACT_ACTION = 'no-turn';
 const controller = new AbortController();
 const events: AgentEvent[] = [];
 const compact = {
  ...request, cwd, target: { mode: 'resume', session },
  operation: { kind: 'command', name: 'compact', args: '' },
 } as const;
 const host = {
  signal: controller.signal,
  emit: async (event: AgentEvent) => { events.push(event); },
  callTool: async () => { throw Error('Unexpected tool call'); },
 };
 const pending = agent.run(compact, host);
 try {
  const deadline = Date.now() + 2000;
  while (!(await readFile(log, 'utf8')).includes('"method":"thread/compact/start"')) {
   if (Date.now() >= deadline) throw Error('Compaction request was not dispatched');
   await Bun.sleep(10);
  }
  controller.abort();
  expect(await pending).toEqual({ status: 'unknown', diagnostic: { stage: 'turn-completion', reason: 'unconfirmed' } });
  expect(events).toEqual([]);
  expect(await agent.run(compact, host)).toEqual({ status: 'interrupted' });
 } finally {
  controller.abort();
  await pending;
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_COMPACT_ACTION;
  await rm(cwd, { recursive: true, force: true });
 }
});
