import { Store } from './store/index';
import { isAbsolute, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { opendir, realpath } from 'node:fs/promises';

const maxListedFolders = 500;

async function listFolders(path: string) {
 const current = await realpath(path);
 const directory = await opendir(current);
 const directories: {name: string; path: string}[] = [];
 let truncated = false;
 for await (const entry of directory) {
  // Symbolic links are not followed while listing. Real directories only.
  if (!entry.isDirectory()) continue;
  if (directories.length === maxListedFolders) { truncated = true; break; }
  directories.push({name:entry.name,path:join(current,entry.name)});
 }
 directories.sort((a,b) => a.name.localeCompare(b.name, 'ja', {numeric:true}));
 const parent = dirname(current);
 return {path:current,parent:parent === current ? null : parent,directories,truncated};
}

const row = (value: unknown): Record<string, any> => value as Record<string, any>;
const projectTask = (value: unknown) => { const t = row(value); return {id:t.id, projectId:t.project_id, name:t.name, phase:t.phase, status:t.status}; };
export function createHandler(store: Store, initialFolder = homedir()) {
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.hostname !== '127.0.0.1') return new Response('Forbidden',{status:403});
  const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if (request.method === 'GET') {
   if (url.pathname === '/' || url.pathname === '/settings' || /^\/project\/[1-9]\d*$/.test(url.pathname) || ['/ui/index.html','/ui/build/app.js','/ui/generated.css'].includes(url.pathname)) {
    const file = url.pathname.startsWith('/ui/') ? url.pathname.slice('/ui/'.length) : 'index.html';
    return new Response(Bun.file(new URL(`./ui/${file}`,import.meta.url)),{headers:{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
   }
   if (url.pathname === '/api/state') return json({projects:store.projects(),tasks:store.tasks().map(projectTask)});
   const match = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
   if (match) { const task=store.task(Number(match[1])); if (!task) return json({error:'タスクが見つかりません'},404); const t=projectTask(task); return json({task:t,messages:store.messages(t.projectId,t.id),documents:store.documents(t.id).map(d=>{const item=row(d);return {name:item.kind==='requirements'?'指示書.md':item.kind,content:item.content,version:item.version}})}); }
   return json({error:'見つかりません'},404);
  }
  if (request.method !== 'POST' || request.headers.get('origin') !== url.origin || request.headers.get('content-type') !== 'application/json') return json({error:'アクセスできません'},403);
  try {
   if (Number(request.headers.get('content-length') || 0)>65536) return json({error:'入力が長すぎます'},413);
   const body = await request.text();
   if (new TextEncoder().encode(body).byteLength > 65536) return json({error:'入力が長すぎます'},413);
   const input = JSON.parse(body) as Record<string,unknown>;
   if (!input || typeof input !== 'object' || Array.isArray(input)) return json({error:'入力を確認してください'},400);
   if (url.pathname === '/api/folders/list') {
    const path = input.path === undefined ? initialFolder : input.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return json({error:'フォルダを確認してください'},400);
    try { return json(await listFolders(path)); }
    catch { return json({error:'フォルダを開けませんでした'},400); }
   }
   if (url.pathname === '/api/projects') {if(typeof input.name!=='string'||typeof input.folder!=='string'||!isAbsolute(input.folder)) return json({error:'名前と絶対パスを入力してください'},400);return json(store.createProject(input.name,input.folder),201)}
   if (url.pathname === '/api/tasks') {if(typeof input.name!=='string'||!Number.isSafeInteger(input.projectId)||Number(input.projectId)<=0)return json({error:'タスク名とプロジェクトを確認してください'},400);return json(projectTask(store.createTask(Number(input.projectId),input.name)),201)}
   const match=url.pathname.match(/^\/api\/tasks\/(\d+)\/messages$/);
   if(match){const task=store.task(Number(match[1]));if(!task)return json({error:'タスクが見つかりません'},404);if(typeof input.content!=='string')return json({error:'入力を確認してください'},400);const t=projectTask(task);return json(store.addMessage(t.projectId,t.id,'user',input.content),201)}
   return json({error:'見つかりません'},404);
  } catch {return json({error:'入力または保存先を確認してください'},400)}
 };
}
if (import.meta.main) {
 const store = new Store(process.env.BENI_DB ?? 'beni.sqlite');
 const port = Number(process.env.BENI_PORT ?? 3210);
 const server = Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:65536,fetch:createHandler(store)});
 console.log(`Beni: http://127.0.0.1:${server.port}/`);
}
