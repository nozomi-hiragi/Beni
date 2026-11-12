import { waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Communication } from './communication';
import { ChatSync } from './chat-sync';
import { FakeWebSocket, packHeader, testPack } from '../test/test-events';
import { packHash, type Pack } from '../../shared/communication';

const json = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const disposals: (() => void)[] = [];
beforeEach(() => { FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const listener = () => ({ subscribed: vi.fn(), event: vi.fn(), error: vi.fn() });

it('shares a socket and a topic scope, and ignores released subscriptions', async () => {
  const transport = new Communication(), first = listener(), second = listener(), documents = listener();
  const releaseFirst = transport.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000001', taskId:'019a0000-0000-7100-8000-000000000002'}, first);
  const releaseSecond = transport.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000001', taskId:'019a0000-0000-7100-8000-000000000002'}, second);
  const releaseDocuments = transport.subscribe('documents', {projectId:'019a0000-0000-7000-8000-000000000001', taskId:'019a0000-0000-7100-8000-000000000002'}, documents);
  disposals.push(releaseFirst, releaseSecond, releaseDocuments);
  await waitFor(() => expect(documents.subscribed).toHaveBeenCalledOnce());
  const socket = FakeWebSocket.instances[0];
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(socket.sent.filter(message => message.type === 'subscribe')).toHaveLength(2);
  socket.change(); expect(first.event).toHaveBeenCalledOnce(); expect(second.event).toHaveBeenCalledOnce();
  releaseFirst(); socket.change(); expect(first.event).toHaveBeenCalledOnce(); expect(second.event).toHaveBeenCalledTimes(2);
  const chatId = [...socket.subscriptions].find(([, sub]) => sub.topic === 'chat')![0];
  releaseSecond(); socket.receive({type:'event', subscriptionId:chatId, name:'chat.changed', data:{}});
  expect(second.event).toHaveBeenCalledTimes(2);
  expect(socket.closed).toBe(false);
  releaseDocuments(); expect(socket.closed).toBe(true);
});

it('reconnects with restored subscriptions and guards old socket callbacks', async () => {
  vi.useFakeTimers();
  const transport = new Communication(), events = listener();
  disposals.push(transport.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000002', taskId: null}, events));
  await vi.advanceTimersByTimeAsync(0);
  const old = FakeWebSocket.instances[0], oldMessage = old.onmessage!;
  old.close(); await vi.advanceTimersByTimeAsync(1_000);
  const next = FakeWebSocket.instances[1];
  expect(events.subscribed).toHaveBeenCalledTimes(2);
  const id = [...next.subscriptions.keys()][0];
  oldMessage({data:JSON.stringify({type:'event',subscriptionId:id,name:'chat.changed',data:{}})});
  expect(events.event).not.toHaveBeenCalled();
  next.change(); expect(events.event).toHaveBeenCalledOnce();
});

it('stops retrying unsupported versions and bounds malformed protocol retries', async () => {
  vi.useFakeTimers();
  const unsupported = new Communication(), events = listener();
  disposals.push(unsupported.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000003', taskId: null}, events));
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.instances[0].receive({type:'error',code:'UNSUPPORTED_VERSION',message:'Unsupported'});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(events.error).toHaveBeenCalled();
  const malformed = new Communication();
  disposals.push(malformed.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000004', taskId: null}, listener()));
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances.at(-1)!.receive({type:'wrong'});
  }
  const total = FakeWebSocket.instances.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(total);
});

it('recovers subscription INTERNAL_ERROR and disconnects on outbound backpressure', async () => {
  vi.useFakeTimers();
  const transport = new Communication(), events = listener();
  disposals.push(transport.subscribe('documents', {projectId:'019a0000-0000-7000-8000-000000000005', taskId:'019a0000-0000-7100-8000-000000000001'}, events));
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeWebSocket.instances[0];
  socket.receive({type:'error', code:'INTERNAL_ERROR', message:'Unavailable', subscriptionId:[...socket.subscriptions.keys()][0]});
  await vi.advanceTimersByTimeAsync(1_000);
  expect(events.subscribed).toHaveBeenCalledTimes(2);
  const next = FakeWebSocket.instances[1]; next.bufferedAmount = 2_000_000;
  disposals.push(transport.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000005', taskId:'019a0000-0000-7100-8000-000000000001'}, listener()));
  expect(next.closed).toBe(true);
});

function syncFor(projectId: string) {
  let view: Pack[] = [];
  const error = vi.fn();
  const sync = new ChatSync({projectId, taskId:null}, packs => { view = packs; }, error);
  disposals.push(() => sync.dispose());
  return {sync, error, view: () => view};
}

it('uses the canonical payload hash and replaces mismatched text with the saved pack', async () => {
  const saved = testPack('Complete reply');
  let closed = false;
  const fetchMock = vi.fn((path: string) => Promise.resolve(json(path.endsWith('/ack') ? {matched:false, pack:saved} : {packs:[{packId:saved.packId,state:closed?'closed':'streaming'}]})));
  vi.stubGlobal('fetch', fetchMock);
  const {sync, view} = syncFor('019a0000-0000-7000-8000-0000000003e9');
  sync.subscribed();
  sync.event({name:'chat.pack.delta',data:{packId:saved.packId,delta:'reply',header:{...packHeader(saved),state:'streaming',status:'streaming'}}});
  closed = true; sync.event({name:'chat.pack.closed',data:{packId:saved.packId,header:packHeader(saved)}});
  await waitFor(() => expect(view()[0]?.content).toBe('Complete reply'));
  const request = fetchMock.mock.calls.find(([path]) => path.endsWith('/ack'))!;
  const init = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([path]) => path === request[0])![1];
  expect(JSON.parse(String(init.body)).hash).toBe(await packHash({...saved,content:'reply'}));
  sync.event({name:'chat.pack.delta',data:{packId:saved.packId,delta:'late',header:packHeader(saved)}});
  expect(view()).toHaveLength(1); expect(view()[0].content).toBe('Complete reply');
});

it('resets partial text on reconnect and fetches missed closed packs and tools in order', async () => {
  const first = testPack('Saved first'), tool = testPack('', {packId:'tool',sequence:2,kind:'tool',tool:{name:'read',input:'example.md',output:'result'}});
  let stage = 0;
  const fetchMock = vi.fn((path: string) => {
    if (path.includes('/packs?')) return Promise.resolve(json({packs:stage === 0 ? [{packId:first.packId,state:'streaming'}] : [first,tool].map(pack => ({packId:pack.packId,state:pack.state}))}));
    return Promise.resolve(json({pack:path.includes('/packs/tool?')?tool:first}));
  });
  vi.stubGlobal('fetch', fetchMock);
  const {sync,view} = syncFor('019a0000-0000-7000-8000-0000000003ea');
  sync.subscribed(); sync.event({name:'chat.pack.delta',data:{packId:first.packId,delta:'partial',header:{...packHeader(first),state:'streaming'}}});
  expect(view()[0].content).toBe('partial');
  stage = 1; sync.subscribed(); expect(view()).toHaveLength(0);
  await waitFor(() => expect(view()).toEqual([first,tool]));
  expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/ack'))).toBe(false);
  sync.dispose();
  const restored = syncFor('019a0000-0000-7000-8000-0000000003ea'); expect(restored.view()).toEqual([first,tool]);
});

it('serializes dirty syncs, preserves newer deltas, and confirms only a closed prefix', async () => {
  const first = testPack('First'), second = testPack('Second',{packId:'second',sequence:2});
  let release!: (value: Response) => void, calls = 0, firstClosed = false;
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path.endsWith('/ack')) return Promise.resolve(json({matched:true}));
    if (!path.includes('/packs?')) return Promise.resolve(json({pack:path.includes('/second?')?second:first}));
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => {release=resolve;});
    const after = new URL(path,'http://localhost').searchParams.get('afterPackId');
    return Promise.resolve(json({packs:after === second.packId ? [] : [first,second].map(pack=>({packId:pack.packId,state:pack===first&&!firstClosed?'streaming':'closed'}))}));
  }));
  const {sync,view} = syncFor('019a0000-0000-7000-8000-0000000003eb'); sync.subscribed();
  sync.event({name:'chat.pack.delta',data:{packId:first.packId,delta:'First',header:{...packHeader(first),state:'streaming'}}});
  sync.event({name:'chat.pack.closed',data:{packId:second.packId,header:packHeader(second)}});
  sync.refresh(); sync.refresh(); expect(calls).toBe(1);
  release(json({packs:[{packId:first.packId,state:'streaming'},{packId:second.packId,state:'closed'}]}));
  await waitFor(()=>expect(calls).toBe(2));
  expect(view()).toHaveLength(1); expect(view()[0].content).toBe('First');
  firstClosed=true; sync.event({name:'chat.pack.closed',data:{packId:first.packId,header:packHeader(first)}});
  await waitFor(()=>expect(view()).toEqual([first,second]));
});

it('surfaces malformed or failed HTTP sync and recovers on explicit refresh', async () => {
  let valid = false;
  const pack = testPack('Recovered');
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(json(path.includes('/packs?') ? valid ? {packs:[{packId:pack.packId,state:'closed'}]} : {packs:[{packId:pack.packId,state:'invalid'}]} : {pack}))));
  const {sync,error,view} = syncFor('019a0000-0000-7000-8000-0000000003ec'); sync.subscribed();
  await waitFor(()=>expect(error).toHaveBeenCalledWith(expect.stringContaining('同期できませんでした')));
  valid=true; sync.refresh();
  await waitFor(()=>expect(view()).toEqual([pack]));
  expect(error).toHaveBeenLastCalledWith('');
});


it('bounds subscriptions and retries a missing hello response after the timeout', async () => {
  vi.useFakeTimers();
  class SilentWebSocket extends FakeWebSocket { override send(raw: string) { this.sent.push(JSON.parse(raw)); } }
  vi.stubGlobal('WebSocket', SilentWebSocket);
  const transport = new Communication(), overflow = listener();
  for (let index = 1; index <= 32; index++) disposals.push(transport.subscribe('chat', {projectId:`019a0000-0000-7000-8000-${index.toString(16).padStart(12,'0')}`,taskId:null}, listener()));
  disposals.push(transport.subscribe('chat', {projectId:'019a0000-0000-7000-8000-000000000021',taskId:null}, overflow));
  expect(overflow.error).toHaveBeenCalledWith('購読数が上限に達しました');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(FakeWebSocket.instances[0].closed).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

it('times out a stuck pack request and ignores a disposed scope response', async () => {
  vi.useFakeTimers();
  let release!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    release = resolve;
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })));
  const {sync,error,view} = syncFor('019a0000-0000-7000-8000-0000000003ed'); sync.subscribed();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('同期できませんでした'));
  sync.refresh(); sync.dispose();
  release(json({packs:[{packId:'old',state:'closed'}]}));
  await vi.advanceTimersByTimeAsync(0);
  expect(view()).toEqual([]);
});


it('resets the failure budget after stable service and explains a permanent stop', async () => {
  vi.useFakeTimers();
  const transport = new Communication(), events = listener();
  disposals.push(transport.subscribe('documents', {projectId:'019a0000-0000-7000-8000-000000000006', taskId:'019a0000-0000-7100-8000-000000000001'}, events));
  await vi.advanceTimersByTimeAsync(0);
  const fail = () => FakeWebSocket.instances.at(-1)!.receive({type:'error',code:'INTERNAL_ERROR',message:'Unavailable'});
  fail(); await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(30_000);
  fail(); await vi.advanceTimersByTimeAsync(1_000);
  fail(); await vi.advanceTimersByTimeAsync(1_000);
  expect(FakeWebSocket.instances).toHaveLength(4);
  fail();
  expect(events.error).toHaveBeenLastCalledWith(expect.stringContaining('再読み込みしてください'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeWebSocket.instances).toHaveLength(4);
});

it('keeps terminal sessions distinct and never buffers input across reconnects', async () => {
  vi.useFakeTimers();
  const transport = new Communication(), first = listener(), second = listener();
  const scope = {projectId:'019a0000-0000-7000-8000-000000000014',taskId:null,terminalId:'first'};
  disposals.push(transport.subscribe('terminal',scope,first));
  disposals.push(transport.subscribe('terminal',{...scope,terminalId:'second'},second));
  expect(transport.terminal(scope,{type:'terminal.input',generation:1,data:'offline'})).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  const socket=FakeWebSocket.instances[0];
  expect(socket.subscriptions.size).toBe(2);
  expect(transport.terminal(scope,{type:'terminal.input',generation:1,data:'one'})).toBe(true);
  const id=[...socket.subscriptions].find(([,sub])=>sub.scope.terminalId==='first')![0];
  expect(socket.sent.at(-1)).toEqual({type:'terminal.input',generation:1,data:'one',subscriptionId:id});
  socket.receive({type:'error',code:'FORBIDDEN',subscriptionId:id,message:'操作権がありません'});
  socket.receive({type:'event',subscriptionId:id,name:'terminal.sync.end',data:{sequence:0}});
  expect(first.event).toHaveBeenCalledOnce(); expect(socket.closed).toBe(false);
  socket.close();
  expect(transport.terminal(scope,{type:'terminal.input',generation:1,data:'lost'})).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  const next=FakeWebSocket.instances[1];
  expect(next.sent.some(message=>message.type==='terminal.input')).toBe(false);
});
