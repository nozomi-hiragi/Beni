import { openSync, readSync, closeSync, mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, renameSync, rmSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validTaskId } from '../shared/ids';

export const initialImplementationPlan = '# Implementation plan\n\nNot planned yet.\n';
export const implementationPlanReady = (documents: {name:string;content:string}[]) => {
 const content=documents.find(document=>document.name==='implementation.md')?.content.trim();
 return !!content && content!==initialImplementationPlan.trim();
};

// Reject symlinks in managed paths: document writes must remain inside this project.
function directory(path: string) {
 try { mkdirSync(path, {mode:0o700}); } catch (error: any) { if(error.code !== 'EEXIST') throw error; }
 const stat=lstatSync(path); if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid document directory');
 return path;
}
export function projectDocuments(folder: string) {
 const root=realpathSync(folder);
 if(!lstatSync(root).isDirectory()) throw Error('Invalid project directory');
 return directory(join(directory(join(root,'.beni')),'tasks'));
}
function regularFile(path: string) {
 const stat=lstatSync(path);
 if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid document file');
 return stat;
}
export function taskDocuments(folder: string, taskId: string, seeds: {requirements: string; plan?: string}, newTask=false) {
 if(!validTaskId(taskId)) throw Error('Invalid task');
 const root=projectDocuments(folder), path=join(root,String(taskId));
 if(newTask) { // A directory left by an interrupted creation must not be silently reused.
  try { lstatSync(path); throw Error('Task document directory already exists'); } catch(error:any) { if(error.code!=='ENOENT') throw error; }
 }
 const target=newTask?mkdtempSync(join(root,'.creating-')):directory(path);
 try {
 for(const [name,content] of [['requirements.md',seeds.requirements],['documents.md','# 仕様整理\n\n## 資料\n\n## 仕様\n'],['implementation.md',seeds.plan ?? initialImplementationPlan]]) {
  const file=join(target,name);
  try { writeFileSync(file,content,{flag:'wx',mode:0o600}); } catch(error:any) { if(error.code!=='EEXIST') throw error; }
  regularFile(file);
 }
 if(newTask) renameSync(target,path);
 } catch(error) { if(newTask) rmSync(target,{recursive:true,force:true}); throw error; }
 return path;
}
export function readTaskDocuments(path: string) {
 // Additional English-named Markdown documents created by the agent are included.
 return readdirSync(path).filter(name=>/^[a-z][a-z0-9-]*\.md$/.test(name)).sort((a,b)=>a==='requirements.md'?-1:b==='requirements.md'?1:a.localeCompare(b)).map(name=>{
  const file=join(path,name),stat=regularFile(file);
  if(stat.size>1024*1024) throw Error('Document too large');
  return {name,path:name,content:readFileSync(file,'utf8'),version:stat.mtimeMs};
 });
}


// 大きな文書も一定量のメモリで比較し、プレビューの上限とは切り離す。
export function taskDocumentSnapshot(path: string) {
 const result: Record<string,{hash:string;modifiedAt:number}> = {};
 const buffer=Buffer.alloc(64*1024);
 for(const name of readdirSync(path).filter(name=>/^[a-z][a-z0-9-]*\.md$/.test(name)).sort()) {
  const file=join(path,name),stat=regularFile(file),hash=createHash('sha256');
  const fd=openSync(file,'r');
  try {for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;hash.update(buffer.subarray(0,count))}}finally{closeSync(fd)}
  result[name]={hash:hash.digest('hex'),modifiedAt:stat.mtimeMs};
 }
 return result;
}
export function documentContentsKey(snapshot: Record<string,{hash:string}>) {
 return JSON.stringify(Object.entries(snapshot).map(([name,entry])=>[name,entry.hash]));
}


export function watchTaskDocuments(path:string, changed:()=>void, failed:()=>void) {
 const original=lstatSync(path);
 if(!original.isDirectory()||original.isSymbolicLink())throw Error('Invalid document directory');
 let previous=documentContentsKey(taskDocumentSnapshot(path));
 let timer:ReturnType<typeof setTimeout>|undefined;
 const watcher=watch(path,(_event,filename)=>{
  if(filename!==null && /^task\.json(?:\.tmp-[a-f0-9-]+)?$/.test(String(filename)))return;
  try{const current=lstatSync(path);if(current.isSymbolicLink()||current.ino!==original.ino||current.dev!==original.dev){failed();return}}catch{failed();return}
  // Rename notifications can name only the temporary source file. Invalidate the
  // small task directory on every event and let the snapshot filter Markdown.
  if(timer===undefined)timer=setTimeout(()=>{timer=undefined;try{const next=documentContentsKey(taskDocumentSnapshot(path));if(next!==previous){previous=next;changed()}}catch{failed()}},40);
 });
 watcher.on('error',failed);
 return ()=>{clearTimeout(timer);watcher.close()};
}

export function retrospectiveDocument(path:string) {
 const file=join(path,'retrospective.md');
 try {writeFileSync(file,'# 反省会\n\n## 未達・意図との差\n\n## 原因\n\n## 次回への改善\n',{flag:'wx',mode:0o600})} catch(error:any){if(error.code!=='EEXIST')throw error}
 regularFile(file);
}
export function projectKnowledge(folder:string, create=true) {
 const root=realpathSync(folder), path=join(directory(join(root,'.beni')),'knowledge.md');
 if(create)try {writeFileSync(path,'# プロジェクトの学び\n',{flag:'wx',mode:0o600})}catch(error:any){if(error.code!=='EEXIST')throw error}
 try {
  if(regularFile(path).size>1024*1024)throw Error('Knowledge too large');
 }catch(error:any){if(create||error.code!=='ENOENT')throw error}
 return path;
}
