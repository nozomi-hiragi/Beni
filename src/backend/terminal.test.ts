import { test, expect } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalService } from './terminal';
import { Store } from './store';
import { ChatService } from './chat';
import { createServerOptions } from './server';
import { validTerminalAction, type TerminalSession, type TopicEvent } from '../shared/communication';
const wait = async (condition:()=>boolean) => {const end=Date.now()+4000;while(!condition()){if(Date.now()>end)throw new Error('Terminal condition timed out');await Bun.sleep(10)}};
function view(service:TerminalService,session:TerminalSession) {
 const events:TopicEvent[]=[];const subscription=service.subscribe({projectId:session.projectId,taskId:null,terminalId:session.id},event=>events.push(event));subscription.start!();
 const state=()=>{const event=events.findLast(e=>e.name==='terminal.state');if(event?.name!=='terminal.state')throw new Error('No state');return event.data};
 return {events,subscription,state,ready:()=>events.some(e=>e.name==='terminal.sync.end'),text:()=>events.flatMap(e=>e.name==='terminal.output'||e.name==='terminal.sync.chunk'?[e.data.data]:[]).join('')};
}

test('PTY shells preserve cwd, owner generations, view-only isolation and bounded validated actions',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-terminal-'));const service=new TerminalService('/bin/sh');
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000001',folder,'request-one');expect(service.create('019a0000-0000-7000-8000-000000000001',folder,'request-one').id).toBe(session.id);
  const a=view(service,session),b=view(service,session);await wait(()=>a.ready()&&b.ready());
  expect(a.state().owner).toBe(true);expect(b.state().owner).toBe(false);
  const old=a.state();expect(()=>b.subscription.message!({type:'terminal.input',generation:old.generation,data:'exit\n'})).toThrow();
  a.subscription.message!({type:'terminal.input',generation:old.generation,data:"printf '\\nCWD:'; pwd\n"});await wait(()=>a.text().includes('CWD:'+folder.replace('/var/','/private/var/'))||a.text().includes('CWD:'+folder));
  b.subscription.message!({type:'terminal.takeover',generation:b.state().generation});const current=b.state();expect(current.owner).toBe(true);expect(current.generation).toBeGreaterThan(old.generation);expect(current.controlToken).not.toBe(old.controlToken);
  expect(()=>a.subscription.message!({type:'terminal.input',generation:old.generation,data:'exit\n'})).toThrow();
  expect(()=>a.subscription.message!({type:'terminal.resize',generation:old.generation,cols:100,rows:30})).toThrow();
  await expect(service.close('019a0000-0000-7000-8000-000000000001',session.id,old.controlToken!)).rejects.toThrow('操作権');
  b.subscription.message!({type:'terminal.resize',generation:current.generation,cols:100,rows:30});await wait(()=>service.list('019a0000-0000-7000-8000-000000000001')[0].cols===100);
  b.subscription.stop();expect(a.state().owner).toBe(false);a.subscription.stop();
  const c=view(service,session);await wait(c.ready);expect(c.state().owner).toBe(true);expect(service.list('019a0000-0000-7000-8000-000000000001')).toHaveLength(1);
  await service.close('019a0000-0000-7000-8000-000000000001',session.id,c.state().controlToken!);expect(service.list('019a0000-0000-7000-8000-000000000001')).toHaveLength(0);c.subscription.stop();
  expect(()=>service.create('019a0000-0000-7000-8000-000000000001',folder,'request-one')).toThrow('終了済み');
  expect(validTerminalAction({type:'terminal.input',generation:1,data:'x'.repeat(4097)})).toBe(false);
  expect(validTerminalAction({type:'terminal.resize',generation:1,cols:1,rows:1})).toBe(false);
 } finally {await service.dispose();await rm(folder,{recursive:true,force:true})}
});

test('reconnect serializes complete alternate screen, unicode and cursor state while retaining naturally exited tabs',async()=>{
 const service=new TerminalService('/bin/sh');const client=new Terminal({allowProposedApi:true,cols:80,rows:24});
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000002',tmpdir(),'screen-request');const first=view(service,session);await wait(first.ready);
  first.subscription.message!({type:'terminal.input',generation:first.state().generation,data:"printf '\\033[?1049h\\033[2J\\033[3;4H\\033[31m漢字😀\\033[0m'; printf '\\nSCREEN_READY\\n'\n"});await wait(()=>first.text().includes('SCREEN_READY\r\n'));
  first.subscription.stop();const second=view(service,session);await wait(second.ready);
  for(const event of second.events){if(event.name==='terminal.sync.chunk')await new Promise<void>(resolve=>client.write(event.data.data,resolve))}
  expect(Array.from({length:24},(_,i)=>client.buffer.active.getLine(i)?.translateToString()).join('\n')).toContain('漢字😀');
  expect(client.buffer.active.type).toBe('alternate');
  const sequences=second.events.filter(e=>e.name==='terminal.output').map(e=>e.data.sequence);expect(sequences.every((n,i)=>i===0||n===sequences[i-1]+1)).toBe(true);
  second.subscription.message!({type:'terminal.input',generation:second.state().generation,data:'exit 7\n'});await wait(()=>service.list('019a0000-0000-7000-8000-000000000002')[0].status==='exited');expect(service.list('019a0000-0000-7000-8000-000000000002')[0].exitCode).toBe(7);expect(service.list('019a0000-0000-7000-8000-000000000002')).toHaveLength(1);
  await service.close('019a0000-0000-7000-8000-000000000002',session.id,second.state().controlToken!);second.subscription.stop();
 } finally {client.dispose();await service.dispose()}
});

test('headless terminal answers cursor queries without a connected owner and drains trailing exit output',async()=>{
 const service=new TerminalService('/bin/sh');
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'query-request');const v=view(service,session);await wait(v.ready);
  v.subscription.message!({type:'terminal.input',generation:v.state().generation,data:"sleep 0.1; stty raw -echo; printf '\\033[6n'; dd bs=1 count=6 2>/dev/null; printf '\\r\\nQUERY_DONE\\r\\n'; exit 0\n"});v.subscription.stop();
  await wait(()=>service.list('019a0000-0000-7000-8000-000000000001')[0].status==='exited');expect(service.list('019a0000-0000-7000-8000-000000000001')[0].exitCode).toBe(0);
  const restored=view(service,session);await wait(restored.ready);expect(restored.text()).toContain('QUERY_DONE');
  await service.close('019a0000-0000-7000-8000-000000000001',session.id,restored.state().controlToken!);restored.subscription.stop();
 }finally{await service.dispose()}
});

test('close waits for the shell exit notification and trailing output before disposing its screen',async()=>{
 const service=new TerminalService('/bin/sh');
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'finalize-request');const v=view(service,session);await wait(v.ready);
  v.subscription.message!({type:'terminal.input',generation:v.state().generation,data:"printf 'TRAILING_'; printf CLOSE; exit 0\n"});
  await wait(()=>v.text().includes('TRAILING_CLOSE'));await service.close('019a0000-0000-7000-8000-000000000001',session.id,v.state().controlToken!);
  expect(v.text()).toContain('TRAILING_CLOSE');expect(v.events.some(e=>e.name==='terminal.state'&&e.data.session.status==='exited')).toBe(true);expect(service.list('019a0000-0000-7000-8000-000000000001')).toEqual([]);v.subscription.stop();
 }finally{await service.dispose()}
});

test('explicit close terminates shell children including a separate job-control process group',async()=>{
 const service=new TerminalService('/bin/sh');
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'child-request');const v=view(service,session);await wait(v.ready);
  v.subscription.message!({type:'terminal.input',generation:v.state().generation,data:"sleep 30 & printf '\\nCHILD:'; jobs -p\n"});await wait(()=>/CHILD:(\d+)/.test(v.text()));const pid=Number(v.text().match(/CHILD:(\d+)/)![1]);
  expect(()=>process.kill(pid,0)).not.toThrow();await service.close('019a0000-0000-7000-8000-000000000001',session.id,v.state().controlToken!);
  await wait(()=>{try{process.kill(pid,0);return false}catch{return true}});v.subscription.stop();
 } finally {await service.dispose()}
});

test('spawn failure is listed and can be acquired and removed; project and global session limits are enforced',async()=>{
 const service=new TerminalService('/nonexistent-beni-test-shell');
 try {
  const session=service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'failed-request');expect(session.status).toBe('failed');const v=view(service,session);await wait(v.ready);await service.close('019a0000-0000-7000-8000-000000000001',session.id,v.state().controlToken!);v.subscription.stop();
  for(let i=0;i<8;i++)service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'limit-'+i);
  expect(()=>service.create('019a0000-0000-7000-8000-000000000001',tmpdir(),'ninth')).toThrow('上限');
 }finally{await service.dispose()}
});

test('HTTP terminal management uses existing origin checks and common WS validates owner actions',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-terminal-api-'));const store=new Store(':memory:');const service=new TerminalService('/bin/sh');const chat=new ChatService(()=>folder);const project=store.createProject('Example',folder) as {id:string};
 const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,folder,chat,undefined,service)});const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown,requestOrigin=origin)=>fetch(origin+path,{method:'POST',headers:{origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
 const Socket=globalThis.WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};let ws:WebSocket|undefined;
 try {
  expect((await post('/api/terminals',{projectId:project.id,requestId:'blocked'},'https://example.com')).status).toBe(403);
  expect((await post('/api/terminals',{projectId:'019a0000-0000-7000-8000-0000000003e7',requestId:'missing'})).status).toBe(404);
  const response=await post('/api/terminals',{projectId:project.id,requestId:'http-request'});expect(response.status).toBe(201);const session=await response.json() as TerminalSession;
  expect((await (await post('/api/terminals',{projectId:project.id,requestId:'http-request'})).json()).id).toBe(session.id);
  const messages:any[]=[];ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});ws.onmessage=e=>messages.push(JSON.parse(String(e.data)));await new Promise<void>((resolve,reject)=>{ws!.onopen=()=>resolve();ws!.onerror=()=>reject(new Error('WS failed'))});ws.send(JSON.stringify({type:'hello',version:1}));await wait(()=>messages.some(m=>m.type==='ready'));
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'terminal',topic:'terminal',scope:{projectId:project.id,taskId:null,terminalId:session.id}}));await wait(()=>messages.some(m=>m.name==='terminal.state'));
  const state=messages.findLast(m=>m.name==='terminal.state').data;expect(messages.findIndex(m=>m.type==='subscribed')).toBeLessThan(messages.findIndex(m=>m.name==='terminal.sync.begin'));
  ws.send(JSON.stringify({type:'terminal.input',subscriptionId:'terminal',generation:state.generation-1,data:'exit\n'}));await wait(()=>messages.some(m=>m.type==='error'&&m.code==='FORBIDDEN'));
  expect((await post(`/api/terminals/${session.id}/close`,{projectId:project.id,controlToken:'invalid'})).status).toBe(403);
  expect((await post(`/api/terminals/${session.id}/close`,{projectId:project.id,controlToken:state.controlToken})).status).toBe(200);
  expect(await (await fetch(origin+`/api/terminals?projectId=${project.id}`)).json()).toEqual([]);
 }finally{ws?.close();await service.dispose();await server.stop(true);store.close();await rm(folder,{recursive:true,force:true})}
});
