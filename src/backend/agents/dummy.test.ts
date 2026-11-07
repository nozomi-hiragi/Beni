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
