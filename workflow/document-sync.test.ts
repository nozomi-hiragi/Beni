import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppHandler } from './runtime';

const origin='http://127.0.0.1:3210';
function fixture(adapters: Parameters<typeof createAppHandler>[1]) {
 const dir=mkdtempSync(join(tmpdir(),'beni-sync-')), path=join(dir,'db');
 const app=createAppHandler(path,adapters);
 const post=(route:string,body:unknown={},signal?:AbortSignal)=>app.fetch(new Request(origin+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body),signal}));
 return {dir,path,app,post,close(){app.close();rmSync(dir,{recursive:true,force:true})}};
}
async function prepare(f:ReturnType<typeof fixture>){
 expect((await f.post('/api/projects',{name:'Example',folder:f.dir})).status).toBe(201);
 expect((await f.post('/api/tasks',{projectId:1,name:'Task'})).status).toBe(201);
 return join(f.dir,'.beni','tasks','1');
}
test('cancelled generation sees an external edit before settling and never overwrites it',async()=>{
 let started!:()=>void, resolve!: (value:{content:string})=>void;
 const entered=new Promise<void>(r=>started=r), pending=new Promise<{content:string}>(r=>resolve=r);
 const f=fixture({requirements:{generate:()=>{started();return pending}}});
 try {const folder=await prepare(f), controller=new AbortController();
  const response=f.post('/api/tasks/1/workflow/requirements',{requestKey:'one'},controller.signal);
  await entered; writeFileSync(join(folder,'requirements.md'),'external edit');controller.abort();
  const result=await (await response).json();expect(result.status).toBe('unknown');
  expect(readFileSync(join(folder,'requirements.md'),'utf8')).toBe('external edit');
  const db=new Database(f.path);try {expect((db.query("SELECT content FROM documents WHERE kind='requirements' ORDER BY version DESC LIMIT 1").get() as any).content).toBe('external edit')} finally {db.close()}
  resolve({content:'late'});
 } finally {f.close()}
});
test('file publication followed by database failure cannot grant approval',async()=>{
 const f=fixture({plan:{generate:async()=>({content:'generated plan'})}});
 let db:Database|undefined;
 try {const folder=await prepare(f);db=new Database(f.path);
  db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON workflow_events WHEN NEW.kind='plan' BEGIN SELECT RAISE(ABORT,'test'); END");
  expect((await f.post('/api/tasks/1/workflow/plan',{requestKey:'one'})).status).toBe(409);
  expect(readFileSync(join(folder,'implementation-plan.md'),'utf8')).toBe('generated plan');
  db.exec('DROP TRIGGER fail_plan');
  expect((await f.post('/api/tasks/1/workflow/approve',{requirementsVersion:1,planVersion:2})).status).toBe(409);
  expect((db.query("SELECT content FROM documents WHERE kind='plan' ORDER BY version DESC LIMIT 1").get() as any).content).toBe('generated plan');
 } finally {db?.close();f.close()}
});
