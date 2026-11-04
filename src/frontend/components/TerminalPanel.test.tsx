import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalSession, TopicEvent } from '../../shared/communication';

const mocks = vi.hoisted(() => ({ subscribe:vi.fn(), send:vi.fn(), terminals:[] as any[], defer:false, writes:[] as (()=>void)[] }));
vi.mock('../communication', () => ({communication:{subscribe:mocks.subscribe,terminal:mocks.send}}));
vi.mock('@xterm/xterm', () => ({Terminal:class {
  cols = 80; rows = 24; options = {disableStdin:true}; writes:string[] = []; resets = 0; input = (_data:string) => {};
  constructor() { mocks.terminals.push(this); }
  loadAddon() {} open() {} dispose() {} reset() { this.resets++; this.writes=[]; }
  resize(cols:number,rows:number) { this.cols=cols; this.rows=rows; }
  write(data:string,done?:()=>void) { this.writes.push(data); if (mocks.defer) mocks.writes.push(()=>done?.()); else done?.(); }
  onData(listener:(data:string)=>void) { this.input=listener; return {dispose(){}}; }
}}));
vi.mock('@xterm/addon-fit', () => ({FitAddon:class {proposeDimensions(){return {cols:80,rows:24};}}}));
import TerminalPanel from './TerminalPanel';

type Listener = {subscribed():void;event(event:TopicEvent):void;error(message:string):void};
const subscribers = new Map<string,{listener:Listener;stop:ReturnType<typeof vi.fn>}>();
const session = (id='terminal-1'):TerminalSession => ({id,projectId:1,requestId:`request-${id}`,status:'running',exitCode:null,cols:80,rows:24});
const json = (value:unknown,ok=true,status=200) => ({ok,status,json:async()=>value}) as Response;
function state(owner:boolean,generation=1,id='terminal-1') { subscribers.get(id)!.listener.event({name:'terminal.state',data:{session:session(id),owner,generation,controlToken:owner?`token-${generation}`:null}}); }
function sync(id='terminal-1',sequence=0) {
  const listener=subscribers.get(id)!.listener;
  listener.event({name:'terminal.sync.begin',data:{sequence,cols:80,rows:24}});
  listener.event({name:'terminal.sync.chunk',data:{data:'snapshot'}});
  listener.event({name:'terminal.sync.end',data:{sequence}});
}
beforeEach(() => {
  subscribers.clear(); mocks.terminals=[]; mocks.defer=false; mocks.writes=[]; mocks.send.mockReset(); mocks.send.mockReturnValue(true); mocks.subscribe.mockReset();
  mocks.subscribe.mockImplementation((_topic:string,scope:{terminalId?:string},listener:Listener) => { const stop=vi.fn(); subscribers.set(scope.terminalId??'list',{listener,stop}); queueMicrotask(()=>listener.subscribed()); return stop; });
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
});
afterEach(() => {cleanup();vi.unstubAllGlobals();});

it('restores server tabs and keeps their subscriptions when selecting another tab', async () => {
  const fetch=vi.fn(async()=>json([session(),session('terminal-2')])); vi.stubGlobal('fetch',fetch);
  render(()=><TerminalPanel projectId={1}/>);
  await screen.findByRole('tab',{name:'ターミナル 2 · 実行中'});
  expect(subscribers.has('terminal-1')).toBe(true); expect(subscribers.has('terminal-2')).toBe(true);
  fireEvent.click(screen.getByRole('tab',{name:'ターミナル 1 · 実行中'}));
  expect(subscribers.get('terminal-1')!.stop).not.toHaveBeenCalled();
  expect(subscribers.get('terminal-2')!.stop).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(call=>!((call as unknown[])[1] as RequestInit|undefined)?.method)).toBe(true);
});

it('enables input after snapshot and grant, revokes immediately, and never replays disconnected keys', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>json([session()])));
  render(()=><TerminalPanel projectId={1}/>); await screen.findByRole('tab');
  const emulator=mocks.terminals[0];
  state(false); sync(); emulator.input('ignored'); expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'乗っ取る'}));
  expect(mocks.send).toHaveBeenLastCalledWith({projectId:1,taskId:null,terminalId:'terminal-1'},{type:'terminal.takeover',generation:1});
  state(true,2); emulator.input('accepted');
  expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(),{type:'terminal.input',generation:2,data:'accepted'});
  state(false,3); emulator.input('old-owner');
  expect(mocks.send).toHaveBeenCalledTimes(2);
  state(true,4); subscribers.get('terminal-1')!.listener.error('通信切断'); emulator.input('lost');
  subscribers.get('terminal-1')!.listener.subscribed(); state(true,5); emulator.input('before-snapshot'); sync(); emulator.input('new');
  expect(mocks.send).toHaveBeenCalledTimes(3);
  expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(),{type:'terminal.input',generation:5,data:'new'});
  expect(emulator.resets).toBe(2); expect(emulator.writes).toEqual(['snapshot','']);
});

it('requires control to close and retains the tab when closing fails', async () => {
  const fetch=vi.fn(async(path:string,init?:RequestInit)=>init?.method==='POST'?json({error:'終了に失敗しました'},false,500):json([session()])); vi.stubGlobal('fetch',fetch);
  render(()=><TerminalPanel projectId={1}/>); await screen.findByRole('tab');
  state(false); sync(); fireEvent.click(screen.getByRole('button',{name:'ターミナル 1 · 実行中 を閉じる'}));
  expect((await screen.findByRole('alert')).textContent).toContain('操作権を取得');
  expect(fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  state(true,2); fireEvent.click(screen.getByRole('button',{name:'ターミナル 1 · 実行中 を閉じる'}));
  await screen.findByText('終了に失敗しました'); expect(screen.getByRole('tab')).toBeTruthy();
  const request=fetch.mock.calls.find(([,init])=>init?.method==='POST')!;
  expect(request[0]).toBe('/api/terminals/terminal-1/close'); expect(JSON.parse(String(request[1]!.body))).toEqual({projectId:1,controlToken:'token-2'});
});

it('reconciles an ambiguous create by its request id without creating another shell', async () => {
  let created:TerminalSession|undefined; const fetch=vi.fn(async(_path:string,init?:RequestInit)=>{
    if(init?.method==='POST') {created={...session(),requestId:JSON.parse(String(init.body)).requestId};throw new Error('disconnected');}
    return json(created?[created]:[]);
  }); vi.stubGlobal('fetch',fetch);
  render(()=><TerminalPanel projectId={1}/>); await waitFor(()=>expect(fetch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'ターミナルを追加'}));
  await waitFor(()=>expect((screen.getByRole('button',{name:'作成結果を確認'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'作成結果を確認'}));
  await screen.findByRole('tab');
  expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'ターミナルを追加'})).toBeTruthy();
});

it('applies output once and disables input on a sequence gap until a new snapshot', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>json([session()])));
  render(()=><TerminalPanel projectId={1}/>); await screen.findByRole('tab'); state(true);sync();
  const listener=subscribers.get('terminal-1')!.listener, emulator=mocks.terminals[0];
  listener.event({name:'terminal.output',data:{sequence:1,data:'one'}});
  listener.event({name:'terminal.output',data:{sequence:1,data:'duplicate'}});
  expect(emulator.writes).toEqual(['snapshot','','one']);
  listener.event({name:'terminal.output',data:{sequence:3,data:'gap'}}); emulator.input('blocked');
  expect(mocks.send).not.toHaveBeenCalled(); expect(screen.getByText(/出力の順序/)).toBeTruthy();
});


it('renders a live resize only after the preceding snapshot has finished parsing', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>json([session()])));
  render(()=><TerminalPanel projectId={1}/>); await screen.findByRole('tab');
  mocks.defer=true; state(true);sync();
  const emulator=mocks.terminals[0];
  subscribers.get('terminal-1')!.listener.event({name:'terminal.resized',data:{sequence:1,cols:100,rows:30}});
  expect(emulator.cols).toBe(80);
  mocks.writes.shift()!(); // Snapshot parse completes, then its sync barrier runs.
  expect(emulator.cols).toBe(80);
  mocks.writes.shift()!();
  expect(emulator.cols).toBe(100); expect(emulator.rows).toBe(30);
});

it('rejects an oversized paste explicitly and accepts the next small input', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>json([session()])));
  render(()=><TerminalPanel projectId={1}/>); await screen.findByRole('tab');state(true);sync();
  mocks.terminals[0].input('界'.repeat(1366));
  expect(mocks.send).not.toHaveBeenCalled(); expect(screen.getByText(/この入力は送信していません/)).toBeTruthy();
  mocks.terminals[0].input('ok');
  expect(mocks.send).toHaveBeenLastCalledWith(expect.anything(),{type:'terminal.input',generation:1,data:'ok'});
});
