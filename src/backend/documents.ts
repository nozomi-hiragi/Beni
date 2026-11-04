import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, renameSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';

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
export function taskDocuments(folder: string, taskId: number, seeds: {requirements: string; plan?: string}, newTask=false) {
 if(!Number.isSafeInteger(taskId)||taskId<=0) throw Error('Invalid task');
 const root=projectDocuments(folder), path=join(root,String(taskId));
 if(newTask) { // A directory left by an interrupted creation must not be silently reused.
  try { lstatSync(path); throw Error('Task document directory already exists'); } catch(error:any) { if(error.code!=='ENOENT') throw error; }
 }
 const target=newTask?mkdtempSync(join(root,'.creating-')):directory(path);
 try {
 for(const [name,content] of [['requirements.md',seeds.requirements],['implementation-plan.md',seeds.plan ?? '# Implementation plan\n\nNot planned yet.\n']]) {
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


export function watchTaskDocuments(path:string, changed:()=>void, failed:()=>void) {
 const original=lstatSync(path);
 if(!original.isDirectory()||original.isSymbolicLink())throw Error('Invalid document directory');
 const watcher=watch(path,()=>{
  try{const current=lstatSync(path);if(current.isSymbolicLink()||current.ino!==original.ino||current.dev!==original.dev){failed();return}}catch{failed();return}
  // Rename notifications can name only the temporary source file. Invalidate the
  // small task directory on every event and let the snapshot filter Markdown.
  changed();
 });
 watcher.on('error',failed);
 return ()=>watcher.close();
}
