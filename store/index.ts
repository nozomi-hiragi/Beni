import { Database } from 'bun:sqlite';
export class Store {
 private readonly db: Database;
 constructor(path: string) { this.db=new Database(path,{create:true});this.db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,folder TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id),name TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'requirements',status TEXT NOT NULL DEFAULT 'idle'); CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id),task_id INTEGER REFERENCES tasks(id),role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,version INTEGER NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id,kind,version));`); }
 close(){this.db.close()}
 private text(v:string){if(typeof v!=='string'||!v.trim())throw Error('Empty value');return v.trim()}
 private raw(v:string){if(typeof v!=='string'||!v.trim())throw Error('Empty value');return v}
 projects(){return this.db.query('SELECT * FROM projects ORDER BY id DESC').all()}
 createProject(name:string,folder:string){const r=this.db.query('INSERT INTO projects(name,folder) VALUES (?,?) RETURNING *').get(this.text(name),this.text(folder));return r}
 tasks(projectId?:number){return projectId===undefined?this.db.query('SELECT * FROM tasks ORDER BY id DESC').all():this.db.query('SELECT * FROM tasks WHERE project_id=? ORDER BY id DESC').all(projectId)}
 task(id:number){return this.db.query('SELECT * FROM tasks WHERE id=?').get(id)}
 createTask(projectId:number,name:string){return this.db.transaction(()=>{const task=this.db.query('INSERT INTO tasks(project_id,name) VALUES (?,?) RETURNING *').get(projectId,this.text(name)) as {id:number,name:string};this.db.query('INSERT INTO documents(task_id,kind,version,content) VALUES (?,?,?,?)').run(task.id,'requirements',1,'# '+task.name+'\n');return task}).immediate()}
 messages(projectId:number,taskId:number|null){return this.db.query('SELECT * FROM messages WHERE project_id=? AND task_id IS ? ORDER BY id').all(projectId,taskId)}
 addMessage(projectId:number,taskId:number|null,role:string,content:string){
  if(!['user','assistant','system'].includes(role))throw Error('Invalid role');
  const original=this.raw(content);
  return this.db.transaction(()=>{
   if(taskId!==null&&!this.db.query('SELECT 1 FROM tasks WHERE id=? AND project_id=?').get(taskId,projectId))throw Error('Task project mismatch');
   const message=this.db.query('INSERT INTO messages(project_id,task_id,role,content) VALUES (?,?,?,?) RETURNING *').get(projectId,taskId,role,original) as {id:number};
   // The combined application creates workflow_events at startup. Keep the
   // original chat message and its workflow record in one transaction.
   if(role==='user'&&taskId!==null&&this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_events'").get()){
    this.db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (?,'instruction',?)").run(taskId,JSON.stringify({messageId:message.id,original}));
   }
   return message;
  }).immediate();
 }
 documents(taskId:number){return this.db.query('SELECT * FROM documents WHERE task_id=? ORDER BY id').all(taskId)}
 saveDocument(taskId:number,kind:string,content:string,expectedVersion:number){return this.db.transaction(()=>{const k=this.text(kind);const last=this.db.query('SELECT COALESCE(MAX(version),0) AS version FROM documents WHERE task_id=? AND kind=?').get(taskId,k) as {version:number};if(!Number.isSafeInteger(expectedVersion)||last.version!==expectedVersion)throw Error('Document revision conflict');return this.db.query('INSERT INTO documents(task_id,kind,version,content) VALUES (?,?,?,?) RETURNING *').get(taskId,k,last.version+1,this.raw(content))}).immediate()}
}
