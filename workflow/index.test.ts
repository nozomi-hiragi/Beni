import {test,expect} from 'bun:test';import {Store} from '../store';import {Workflow} from './index';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('approval revisions, durable failures and stale results',async()=>{const dir=mkdtempSync(join(tmpdir(),'beni-flow-')),path=join(dir,'db');try{const s=new Store(path);s.createProject('demo','/tmp/demo');s.createTask(1,'task');let w=new Workflow(path);w.recordInstruction(1,' raw ');w.savePlan(1,1,'plan');await expect(w.execute(1,undefined)).rejects.toThrow();w.approve(1,1,1,'user');let release!:(r:any)=>void;const run=w.execute(1,{execute:()=>new Promise(resolve=>{release=resolve})});await Promise.resolve();await expect(w.execute(1,{execute:async()=>({output:'x',evidence:['x']})})).rejects.toThrow();w.recordInstruction(1,'new');release({output:'done',evidence:['test']});expect((await run).stale).toBe(true);await expect(w.execute(1,{execute:async()=>({output:'x',evidence:['x']})})).rejects.toThrow();w.savePlan(1,1,'new plan');w.approve(1,1,2,'user');expect((await w.execute(1,{execute:async()=>{throw Error('secret')}})).status).toBe('failed');expect(JSON.stringify(w.events(1))).not.toContain('secret');w.close();w=new Workflow(path);expect(w.events(1).at(-1)?.kind).toBe('execution_result');w.close();s.close()}finally{rmSync(dir,{recursive:true,force:true})}});
test('one attempt per approval and explicit unknown outcome recovery',async()=>{const dir=mkdtempSync(join(tmpdir(),'beni-once-')),path=join(dir,'db');try{const s=new Store(path);s.createProject('demo','/tmp/demo');s.createTask(1,'task');const w=new Workflow(path);w.savePlan(1,1,'plan');w.approve(1,1,1,'user');const ok={execute:async()=>({output:'ok',evidence:['test']})};expect((await w.execute(1,ok)).status).toBe('succeeded');await expect(w.execute(1,ok)).rejects.toThrow();w.approve(1,1,1,'user');const failed=await w.execute(1,{execute:async()=>{throw Error('failure')}});await expect(w.execute(1,ok)).rejects.toThrow();expect(()=>w.approve(1,1,1,'user')).toThrow();w.acknowledgeRecovery(1,failed.attemptId,'user');w.approve(1,1,1,'user');const controller=new AbortController();let release!:(r:any)=>void;const running=w.execute(1,{execute:()=>new Promise(resolve=>{release=resolve})},controller.signal);await Promise.resolve();expect(()=>w.approve(1,1,1,'user')).toThrow('Execution still running');controller.abort();const cancelled=await running;expect((cancelled.result as any).outcomeUnknown).toBe(true);await expect(w.execute(1,ok)).rejects.toThrow();expect(()=>w.approve(1,1,1,'user')).toThrow();release({output:'late',evidence:['test']});await Promise.resolve();expect(w.events(1).filter(e=>e.kind==='execution_result'&&e.payload.attemptId===cancelled.attemptId).length).toBe(1);w.acknowledgeRecovery(1,cancelled.attemptId,'user');w.approve(1,1,1,'user');const pre=new AbortController();pre.abort();const before=await w.execute(1,ok,pre.signal);expect((before.result as any).outcomeUnknown).toBe(false);w.approve(1,1,1,'user');w.close();s.close()}finally{rmSync(dir,{recursive:true,force:true})}});
test('interrupted recovery requires acknowledgement and discards late settlement',async()=>{const dir=mkdtempSync(join(tmpdir(),'beni-recover-')),path=join(dir,'db');try{const s=new Store(path);s.createProject('demo','/tmp/demo');s.createTask(1,'task');const w=new Workflow(path);w.savePlan(1,1,'plan');w.approve(1,1,1,'user');let release!:(r:any)=>void;const pending=w.execute(1,{execute:()=>new Promise(resolve=>{release=resolve})});await Promise.resolve();expect(w.recover(1)).toBe(1);expect(()=>w.approve(1,1,1,'user')).toThrow();release({output:'late',evidence:['test']});await expect(pending).rejects.toThrow();const event=w.events(1).find(e=>e.kind==='execution_interrupted');expect(w.events(1).some(e=>e.kind==='execution_result')).toBe(false);w.acknowledgeRecovery(1,event!.payload.attemptId,'user');w.approve(1,1,1,'user');w.close();s.close()}finally{rmSync(dir,{recursive:true,force:true})}});
test('feedback invalidates approval and requires a new plan',async()=>{const dir=mkdtempSync(join(tmpdir(),'beni-feedback-')),path=join(dir,'db');try{const s=new Store(path);s.createProject('demo','/tmp/demo');s.createTask(1,'task');const w=new Workflow(path);w.savePlan(1,1,'plan');w.approve(1,1,1,'user');const executor={execute:async()=>({output:'done',evidence:['test']})};const result=await w.execute(1,executor);w.feedback(1,result.attemptId,'  change layout  ');expect(()=>w.approve(1,1,1,'user')).toThrow('Plan must be regenerated');await expect(w.execute(1,executor)).rejects.toThrow('Current approval required');const event=w.events(1).at(-1)!;expect(event.payload.content).toBe('  change layout  ');expect(event.payload.messageId).toBeGreaterThan(0);w.savePlan(1,1,'revised plan');w.approve(1,1,2,'user');expect((await w.execute(1,executor)).status).toBe('succeeded');w.close();s.close()}finally{rmSync(dir,{recursive:true,force:true})}});
test('running review blocks approval and execution until corrective planning, without blocking other tasks',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'beni-review-gate-')),path=join(dir,'db');
 const s=new Store(path);s.createProject('p','/tmp/p');s.createTask(1,'task');s.createTask(1,'other task');const w=new Workflow(path);
 const {ExecutionReview}=await import('./review');const review=new ExecutionReview(path);
 try{
  w.recordInstruction(1,'original');w.savePlan(1,1,'initial');w.approve(1,1,1,'user');
  w.savePlan(2,1,'other initial');
  const executor={execute:async()=>({output:'done',evidence:['test']})};
  const first=await w.execute(1,executor);let release!:(v:any)=>void;
  const pending=review.review(1,first.attemptId,{review:()=>new Promise(resolve=>{release=resolve})});await Promise.resolve();
  expect(()=>w.approve(1,1,1,'user')).toThrow('Review still running');
  let calls=0;
  await expect(w.execute(1,{execute:async()=>{calls++;return {output:'bypass',evidence:['x']}}})).rejects.toThrow('Review still running');
  expect(calls).toBe(0);
  w.approve(2,1,1,'user');expect((await w.execute(2,executor)).status).toBe('succeeded');
  release({passed:false,feedback:'Fix missing test'});expect((await pending).status).toBe('changes_requested');
  expect(()=>w.approve(1,1,1,'user')).toThrow('Review requires a new plan');
  await expect(w.execute(1,executor)).rejects.toThrow('Review requires a new approval and plan');
  expect(s.messages(1,1).length).toBe(1);
  w.savePlan(1,1,'Revised to add missing test');w.approve(1,1,2,'user');
  expect((await w.execute(1,executor)).status).toBe('succeeded');
 }finally{review.close();w.close();s.close();rmSync(dir,{recursive:true,force:true})}
});
test('running requirements and plan generation block only the same task approval and execution',async()=>{
 const {RequirementsGeneration}=await import('./requirements');const {PlanGeneration}=await import('./plan');
 for(const kind of ['requirements','plan']){
  const dir=mkdtempSync(join(tmpdir(),'beni-generation-gate-')),path=join(dir,'db');
  const s=new Store(path);s.createProject('p','/tmp/p');s.createTask(1,'first');s.createTask(1,'second');const w=new Workflow(path);
  const generation=kind==='requirements'?new RequirementsGeneration(path):new PlanGeneration(path);
  try{
   w.savePlan(1,1,'first plan');w.approve(1,1,1,'user');w.savePlan(2,1,'second plan');
   let release!:(v:any)=>void;const pending=generation.generate(1,'generation',{generate:()=>new Promise(resolve=>{release=resolve})});await Promise.resolve();
   expect(()=>w.approve(1,1,1,'user')).toThrow('generation still running');
   let calls=0;const executor={execute:async()=>{calls++;return {output:'done',evidence:['test']}}};
   await expect(w.execute(1,executor)).rejects.toThrow('generation still running');expect(calls).toBe(0);
   w.approve(2,1,1,'user');expect((await w.execute(2,executor)).status).toBe('succeeded');
   release({content:'updated '+kind});expect((await pending).status).toBe('adopted');
   await expect(w.execute(1,executor)).rejects.toThrow('Current approval required');
  }finally{generation.close();w.close();s.close();rmSync(dir,{recursive:true,force:true})}
 }
});
test('completed review prevents reapproval until a newer plan exists',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'beni-completed-gate-')),path=join(dir,'db');
 const s=new Store(path);s.createProject('p','/tmp/p');s.createTask(1,'task');const w=new Workflow(path);
 const {ExecutionReview}=await import('./review');const review=new ExecutionReview(path);
 try{
  w.savePlan(1,1,'initial');w.approve(1,1,1,'user');const executor={execute:async()=>({output:'done',evidence:['test']})};
  const first=await w.execute(1,executor);expect((await review.review(1,first.attemptId,{review:async()=>({passed:true,feedback:'Checked saved evidence'})})).status).toBe('completed');
  expect(()=>w.approve(1,1,1,'user')).toThrow('Review requires a new plan');
  await expect(w.execute(1,executor)).rejects.toThrow();
  w.savePlan(1,1,'A new iteration after review');w.approve(1,1,2,'user');expect((await w.execute(1,executor)).status).toBe('succeeded');
 }finally{review.close();w.close();s.close();rmSync(dir,{recursive:true,force:true})}
});
