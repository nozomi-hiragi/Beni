import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectDocuments, readTaskDocuments } from '../documents';

/** Import the authoritative task files as immutable workflow revisions. */
export function syncDocuments(db: Database, taskId: number) {
 const task = db.query('SELECT t.name,p.folder FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(taskId) as {name:string;folder:string}|null;
 if (!task) throw Error('Task missing');
 const latest = (kind:string) => db.query('SELECT version,content FROM documents WHERE task_id=? AND kind=? ORDER BY version DESC LIMIT 1').get(taskId,kind) as {version:number;content:string}|null;
 const folder = join(projectDocuments(task.folder), String(taskId));
 const stat = lstatSync(folder);
 if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid task directory');
 const files = readTaskDocuments(folder);
 const requirements = files.find(f=>f.name==='requirements.md');
 const plan = files.find(f=>f.name==='implementation-plan.md');
 if (!requirements || !plan) throw Error('Task documents missing');
 db.transaction(()=>{for (const [kind,content] of [['requirements',requirements.content],['plan',plan.content]]) {const current=latest(kind);if (!current || current.content!==content) db.query('INSERT INTO documents(task_id,kind,version,content) VALUES (?,?,?,?)').run(taskId,kind,(current?.version ?? 0)+1,content)}}).immediate();
 return {folder, requirements: requirements.content, plan: plan.content};
}

/** Replace only a file that still contains the text observed at generation start. */
export function adoptDocument(folder:string, kind:'requirements'|'plan', expected:string, content:string) {
 const name=kind==='requirements'?'requirements.md':'implementation-plan.md';
 const current=readTaskDocuments(folder).find(f=>f.name===name);
 if (!current || current.content!==expected) throw Error('Document changed');
 const path=join(folder,name), tmp=join(folder,`.${randomUUID()}.tmp`);
 try {writeFileSync(tmp,content,{flag:'wx',mode:0o600});if (readFileSync(path,'utf8')!==expected) throw Error('Document changed');renameSync(tmp,path)} finally {try {unlinkSync(tmp)} catch (e:any) {if(e.code!=='ENOENT')throw e}}
}
