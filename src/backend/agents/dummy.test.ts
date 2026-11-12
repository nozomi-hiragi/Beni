import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService } from '../chat';
import { createHandler } from '../server';
import { Store } from '../store/index';
import { DummyAgent } from '../test/dummy-agent';
import type { AgentHost, AgentUsage } from './agent';

const projectId = '019a0000-0000-7000-8000-000000000001';
const waitFor = async (check:()=>Promise<boolean>) => {
 for (let attempt=0;attempt<100;attempt++){
  if(await check())return;
  await Bun.sleep(5);
 }
 throw Error('Dummy run did not finish');
};
const inProject = async (run:(root:string)=>Promise<void>) => {
 const root=await mkdtemp(join(tmpdir(),'beni-dummy-'));
 try{await run(root)}finally{await rm(root,{recursive:true,force:true})}
};

test('登録した Agent だけを使用し、受理とパックを順に保存して再開する', () => inProject(async root=>{
 const emitted=Promise.withResolvers<void>();
 const release=Promise.withResolvers<void>();
 const agent=new DummyAgent({scenario:async (_request,host,accept)=>{
  await accept();
  await host.emit({type:'text.started',itemId:'answer'});
  await host.emit({type:'text.delta',itemId:'answer',delta:'working'});
  await host.emit({type:'text.delta',itemId:'answer',delta:'…'});
  emitted.resolve();
  await release.promise;
  await host.emit({type:'text.completed',itemId:'answer',text:'done'});
  return {status:'completed'};
 }});
 const chat=new ChatService(()=>root,[agent]);
 const deltas:string[]=[];
 chat.subscribe(projectId,null,event=>{if(event.name==='chat.pack.delta')deltas.push(event.data.delta)});
 await chat.send(projectId,null,'hello',null,root);
 try{
  await emitted.promise;
  const current=await chat.get(projectId,null);
  expect(current).toMatchObject({threadId:'session-1',sessionProvider:'dummy',selectedModel:{id:'dummy-model',provider:'dummy'}});
  expect(current.messages.at(-1)).toMatchObject({status:'streaming',content:'working…'});
  expect(deltas).toEqual(['working','…']);
 }finally{release.resolve()}
 await waitFor(async ()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
 const completed=await chat.get(projectId,null);
 expect(completed.packs.map(pack=>pack.content)).toEqual(['hello','done']);
 await chat.send(projectId,null,'resume',null,root);
 await waitFor(async ()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
 expect(agent.requests.map(request=>request.target)).toEqual([
  {mode:'new'},{mode:'resume',session:{agentId:'dummy',id:'session-1'}},
 ]);
 const retired=new ChatService(()=>root,[new DummyAgent({id:'replacement'})]);
 expect((await retired.get(projectId,null)).messages[0]?.provider).toBe('dummy');
 await expect(retired.send(projectId,null,'rejected',null,root,undefined,null,false,'dummy')).rejects.toThrow('unavailable');
}));

test('再開先消失は一度だけやり直し、結果不明と中断を区別する', () => inProject(async root=>{
 const initial=new ChatService(()=>root,[new DummyAgent()]);
 await initial.send(projectId,null,'first',null,root);
 await waitFor(async ()=>(await initial.get(projectId,null)).messages.at(-1)?.status==='completed');
 const started=Promise.withResolvers<void>();
 const agent=new DummyAgent({scenario:async (request,host,accept)=>{
  await accept();
  if(request.operation.kind==='send'&&request.operation.text==='cancel'){
   started.resolve();
   if(!host.signal.aborted)await new Promise<void>(resolve=>host.signal.addEventListener('abort',()=>resolve(),{once:true}));
   return {status:'interrupted'};
  }
  return {status:'unknown'};
 }});
 const chat=new ChatService(()=>root,[agent]);
 await chat.send(projectId,null,'connection lost',null,root);
 await waitFor(async ()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='unknown');
 expect(agent.requests.map(request=>request.target.mode)).toEqual(['resume','new']);
 expect(agent.requests[0]?.sendId).toBe(agent.requests[1]?.sendId);
 expect(agent.requests[1]?.references.join('')).toContain('first');
 await chat.send(projectId,null,'cancel',null,root);
 await started.promise;
 await chat.interrupt(projectId,null);
 expect((await chat.get(projectId,null)).messages.at(-1)?.status).toBe('interrupted');
 expect(agent.requests).toHaveLength(3);
}));

test('登録情報、保守コマンドの別名、利用枠は汎用 API から使える', () => inProject(async root=>{
 const usage:AgentUsage={kind:'snapshot',accountKey:'internal-key',usage:{observedAt:'2026-01-01T00:00:00.000Z',windows:[{label:'5時間枠',usedPercent:12}]}};
 const agent=new DummyAgent({id:'dummy-api',status:()=>({accountKey:'internal-key'}),getUsage:async()=>usage,commands:[
  {name:'describe',kind:'maintenance',description:'状態を表示',requiresSession:false,aliases:['details'],argumentHint:'[対象]'},
 ],scenario:async (_request,_host,accept)=>{
  await accept();
  return {status:'completed',output:'result'};
 }});
 const chat=new ChatService(()=>root,[agent]);
 const store=new Store(':memory:');
 const project=store.createProject('Example',root);
 const handler=createHandler(store,root,chat);
 const origin='http://127.0.0.1';
 const get=(path:string)=>handler(new Request(origin+path));
 const post=(path:string,body:unknown)=>handler(new Request(origin+path,{
  method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body),
 }));
 const list=await (await get('/api/agents')).json();
 expect(list.agents).toEqual([{id:'dummy-api',name:'Dummy',commands:agent.commands,supportsUsage:true}]);
 expect(await (await get('/api/agents/dummy-api/status')).json()).not.toHaveProperty('accountKey');
 expect((await get('/api/agents/codex/status')).status).toBe(404);
 const status=await (await post('/api/agents/dummy-api/status',{})).json();
 expect(status.usage).toEqual(usage.usage);
 expect(status).not.toHaveProperty('accountKey');
 const response=await post('/api/chat/commands',{projectId:project.id,provider:agent.id,command:'details',args:'target'});
 expect(response.status).toBe(202);
 await waitFor(async ()=>(await chat.get(project.id,null)).command?.status==='completed');
 const current=await chat.get(project.id,null);
 expect(current.command).toMatchObject({name:'describe',output:'result'});
 expect(current.threadId).toBeNull();
 expect(current.packs).toEqual([]);
 expect(agent.requests[0]).toMatchObject({target:{mode:'ephemeral'},operation:{kind:'command',name:'describe',args:'target'}});
 expect(()=>new ChatService(()=>root,[agent,agent])).toThrow('duplicate agent');
}));

test('埋め込みツールの範囲を検証し、終了後の呼び出しは拒否する', () => inProject(async root=>{
 let captured:AgentHost|undefined;
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async (_request,host,accept)=>{
  captured=host;
  await accept();
  const valid=await host.callTool({id:'1',name:'acknowledge_events',input:{through:2}});
  expect(valid).toEqual({ok:true,text:'{"through":2}'});
  expect((await host.callTool({id:'2',name:'acknowledge_events',input:{through:3}})).ok).toBe(false);
  expect((await host.callTool({id:'3',name:'other_tool',input:{}})).ok).toBe(false);
  return {status:'completed'};
 }});
 const chat=new ChatService(()=>root,[agent]);
 chat.setTaskEvents({capture:()=>{},events:()=>({events:[],lastEventId:2,through:2,hasMore:false})});
 await chat.send(projectId,null,'review',null,root);
 await waitFor(async ()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
 expect((await chat.get(projectId,null)).lastEventId).toBe(2);
 expect((await captured!.callTool({id:'4',name:'acknowledge_events',input:{through:2}})).ok).toBe(false);
}));

test('接続確認はDBから再利用し、明示更新と無効化だけで再取得する',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 let probes=0;
 let installed=false;
 const agent=new DummyAgent({status:()=>({availability:installed?'ready':'not-installed',checkedAt:`2026-01-01T00:00:0${++probes}.000Z`})});
 const create=()=>{const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);return chat};
 try{
  const chat=create();
  const first=await chat.agentStatus('dummy');
  expect((await chat.agentStatus('dummy')).checkedAt).toBe(first.checkedAt);
  const restarted=create();
  expect((await restarted.agentStatus('dummy')).checkedAt).toBe(first.checkedAt);
  expect(probes).toBe(1);
  installed=true;
  expect((await restarted.refreshAgentUsage('dummy')).availability).toBe('ready');
  expect(store.agentStatus('dummy')?.checkedAt).not.toBe(first.checkedAt);
  expect(probes).toBe(2);
  store.invalidateAgentStatus('dummy');
  await restarted.agentStatus('dummy');
  expect(probes).toBe(3);
  await restarted.send(projectId,null,'hello',null,root);
  await waitFor(async()=>(await restarted.get(projectId,null)).messages.at(-1)?.status==='completed');
  await restarted.agentStatus('dummy');
  expect(probes).toBe(3);
 }finally{store.close()}
}));

test('明示更新より遅い通常確認は新しい接続情報を巻き戻さない',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 const agent=new DummyAgent();
 const old=Promise.withResolvers<Awaited<ReturnType<DummyAgent['getStatus']>>>();
 let probes=0;
 const fresh=await agent.getStatus();
 agent.getStatus=()=>++probes===1?old.promise:Promise.resolve({...fresh,version:'new'});
 const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);
 try{
  const first=chat.agentStatus('dummy');
  const shared=chat.agentStatus('dummy');
  expect(probes).toBe(1);
  expect((await chat.refreshAgentUsage('dummy')).version).toBe('new');
  old.resolve({...fresh,version:'old'});
  expect((await first).version).toBe('new');
  expect((await shared).version).toBe('new');
  expect(store.agentStatus('dummy')?.version).toBe('new');
  expect(probes).toBe(2);
 }finally{store.close()}
}));

test('実行の接続失敗と結果不明だけが接続情報を無効化する',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 let probes=0;
 let result:import('./agent').AgentOutcome={status:'interrupted'};
 const agent=new DummyAgent({status:()=>{probes++;return {}},scenario:async(_request,_host,accept)=>{await accept();return result}});
 const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);
 try{
  for(const outcome of [{status:'interrupted'},{status:'failed',code:'unavailable'},{status:'failed',code:'model-unavailable'},{status:'failed',code:'unsupported'},{status:'unknown'}] as const){
   result=outcome;
   await chat.send(projectId,null,'hello',null,root);
   await waitFor(async()=>!['pending','streaming'].includes((await chat.get(projectId,null)).messages.at(-1)!.status));
   const before=probes;
   await chat.agentStatus('dummy');
   expect(probes).toBe(before+(outcome.status==='interrupted'?0:1));
  }
 }finally{store.close()}
}));

test('異なるアカウントの利用枠で保存済み利用枠を隠し、古い実行は新アカウントへ影響しない',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 let identity='a';
 const usage=(accountKey:string):AgentUsage=>({accountKey,kind:'snapshot',usage:{observedAt:'2026-01-01T00:00:00.000Z',windows:[{label:'枠',usedPercent:10}]}});
 const release=Promise.withResolvers<void>();
 const started=Promise.withResolvers<void>();
 let host:AgentHost|undefined;
 const agent=new DummyAgent({status:()=>({accountKey:identity}),getUsage:async()=>usage(identity),scenario:async(_request,current,accept)=>{
  await accept();host=current;started.resolve();await release.promise;
  await current.emit({type:'usage',data:usage('a')});return {status:'completed'};
 }});
 const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);
 try{
  expect((await chat.refreshAgentUsage('dummy')).usage).not.toBe('unknown');
  await chat.send(projectId,null,'hello',null,root);await started.promise;
  await host!.emit({type:'usage',data:usage('b')});
  expect(store.agentStatus('dummy')).toBeUndefined();
  identity='b';
  expect((await chat.refreshAgentUsage('dummy')).usage).not.toBe('unknown');
  release.resolve();await waitFor(async()=>!['pending','streaming'].includes((await chat.get(projectId,null)).messages.at(-1)!.status));
  expect(store.agentStatus('dummy')?.accountKey).toBe('b');
  expect((await chat.agentStatus('dummy')).usage).not.toBe('unknown');
 }finally{release.resolve();store.close()}
}));

test('接続情報の保存失敗では取得値を返し、古いDB値に戻さず再確認する',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 let probes=0;
 const agent=new DummyAgent({status:()=>({version:String(++probes)})});
 const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);
 const save=store.saveAgentStatus.bind(store);
 try{
  expect((await chat.agentStatus('dummy')).version).toBe('1');
  store.saveAgentStatus=()=>{throw Error('架空の保存失敗')};
  expect((await chat.refreshAgentUsage('dummy')).version).toBe('2');
  store.saveAgentStatus=save;
  expect((await chat.agentStatus('dummy')).version).toBe('3');
  expect(probes).toBe(3);
 }finally{store.close()}
}));

test('保存一覧にないモデルは一度再確認し、通常の保守失敗は接続情報を保つ',()=>inProject(async root=>{
 const store=new Store(join(root,'beni.sqlite'));
 let probes=0;
 let expanded=false;
 const agent=new DummyAgent({commands:[{name:'compact',description:'圧縮',kind:'maintenance',requiresSession:false}],status:()=>{
  probes++;
  return {models:expanded?[{id:'new-model',name:'新モデル'}]:[{id:'dummy-model',name:'Dummy Model'}]};
 },scenario:async(request,_host,accept)=>{await accept();return request.operation.kind==='command'?{status:'failed',code:'nothing-to-compact'}:{status:'completed'}}});
 const chat=new ChatService(()=>root,[agent]);chat.setAgentStore(store);
 try{
  await chat.agentStatus('dummy');expanded=true;
  await chat.send(projectId,null,'hello','new-model',root);
  await waitFor(async()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
  expect(probes).toBe(2);
  await chat.command(projectId,null,'compact',root);
  await waitFor(async()=>(await chat.get(projectId,null)).command?.status==='failed');
  await chat.agentStatus('dummy');
  expect(probes).toBe(2);
 }finally{store.close()}
}));
