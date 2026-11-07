import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function run(overrides: Partial<AgentRequest> = {}) {
 const events: AgentEvent[] = [];
 const outcome = await agent.run({ ...request, ...overrides }, {
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
    events: [], outcome: { status: 'failed', code: 'unavailable' },
   });
  }
 } finally { delete process.env.FAKE_CODEX_UNSAFE_SANDBOX; }
});

test('Codex calls registered tools in the accepted turn even when the request arrived early', async () => {
 const types: string[] = [];
 process.env.FAKE_EMBEDDED_CALLS = JSON.stringify([
  { tool: 'echo', arguments: { text: 'example' } },
  { tool: 'unregistered', arguments: {} },
 ]);
 try {
  const outcome = await agent.run({
   ...request, tools: [{ name: 'echo', description: 'Echoes text.', inputSchema: { type: 'object' } }],
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
 expect((await run({ target, resumeToolsChanged: true })).outcome).toEqual({ status: 'failed', code: 'session-incompatible' });
 try {
  process.env.FAKE_CODEX_RESUME = 'missing';
  expect((await run({ target })).outcome).toEqual({ status: 'failed', code: 'session-missing' });
  process.env.FAKE_AUTH = 'apiKey';
  expect(await run()).toEqual({ events: [], outcome: { status: 'failed', code: 'unavailable' } });
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
  expect(await pending).toEqual({ status: 'unknown' });
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
