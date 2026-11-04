import { Store } from './store/index';
import { ChatService } from './chat';
import { communicationSocket, type SocketData } from './events';
import type { Server } from 'bun';
import { validId } from '../shared/communication';
import { projectDocuments, taskDocuments, readTaskDocuments, watchTaskDocuments } from './documents';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, opendir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const maxListedFolders = 500;
function requestAccess(publicOrigin?: string) {
 const configured = publicOrigin === undefined ? undefined : new URL(publicOrigin);
 if (configured && (configured.protocol !== 'https:' || configured.origin !== publicOrigin)) throw new Error('BENI_PUBLIC_ORIGIN must be an exact HTTPS origin');
 return (request: Request) => {
 const url = new URL(request.url);
 const local = url.hostname === '127.0.0.1';
 const publicHost = configured !== undefined && url.host === configured.host;
 return {allowed:local || publicHost,sameOrigin:request.headers.get('origin') === (publicHost ? configured.origin : url.origin)};
 };
}
const decodePackId=(value:string)=>{try{return decodeURIComponent(value)}catch{return null}};

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
const documentFolder = (store:Store,project:any, task:any) => {
  const stored=store.documents(task.id).map(row);
  const latest=(kind:string)=>stored.filter(d=>d.kind===kind).sort((a,b)=>b.version-a.version)[0]?.content;
  return taskDocuments(project.folder,task.id,{requirements:latest('requirements') ?? '# '+task.name+'\n',plan:latest('implementation-plan')});
 };
const projectForScope = (store:Store,projectId:unknown,taskId:unknown) => {
  if (!Number.isSafeInteger(projectId) || Number(projectId)<=0 || (taskId!==null && (!Number.isSafeInteger(taskId) || Number(taskId)<=0))) return null;
  const project=store.projects().map(row).find(p=>p.id===projectId);
  if (!project) return null;
  if (taskId!==null) {const task=store.task(Number(taskId));if(!task || row(task).project_id!==projectId)return null}
  return project;
 };
export function createHandler(store: Store, initialFolder = homedir(), chat = new ChatService(dataPaths().chatDirectory), publicOrigin?: string) {
 const access=requestAccess(publicOrigin);
 const scope=(p:unknown,t:unknown)=>projectForScope(store,p,t);
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (!access(request).allowed) return new Response('Forbidden',{status:403});
  const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if (request.method === 'GET') {
   if (url.pathname === '/' || url.pathname === '/settings' || /^\/project\/[1-9]\d*$/.test(url.pathname) || ['/ui/index.html','/ui/build/app.js','/ui/generated.css'].includes(url.pathname)) {
    const file = url.pathname === '/ui/build/app.js' ? '../../dist/frontend/app.js' : url.pathname === '/ui/generated.css' ? '../../dist/frontend/generated.css' : '../frontend/index.html';
    return new Response(Bun.file(new URL(file,import.meta.url)),{headers:{'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
   }
   if (url.pathname === '/api/codex/status') return json(await chat.status());
   const packMatch=url.pathname.match(/^\/api\/chat\/packs(?:\/([^/]+))?$/);
   if(packMatch){const p=Number(url.searchParams.get('projectId'));const raw=url.searchParams.get('taskId');const t=raw===null?null:Number(raw);if(!scope(p,t))return json({error:'会話が見つかりません'},404);try{const id=packMatch[1]===undefined?undefined:decodePackId(packMatch[1]);if(id!==undefined&&!validId(id))return json({error:'入力を確認してください'},400);const after=url.searchParams.get('afterPackId');if(after!==null&&!validId(after))return json({error:'入力を確認してください'},400);return json(id?await chat.pack(p,t,id):await chat.packs(p,t,url.searchParams.get('afterPackId')??undefined))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if (url.pathname === '/api/chat') {const p=Number(url.searchParams.get('projectId'));const raw=url.searchParams.get('taskId');const t=raw===null?null:Number(raw);if(!scope(p,t))return json({error:'会話が見つかりません'},404);try{const {packs,...conversation}=await chat.get(p,t);return json(conversation)}catch{return json({error:'履歴を読み込めませんでした'},500)}}
   if (url.pathname === '/api/state') return json({projects:store.projects(),tasks:store.tasks().map(projectTask)});
   const match = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
   if (match) { const task=store.task(Number(match[1])); if (!task) return json({error:'タスクが見つかりません'},404); const t=projectTask(task); try {const project=scope(t.projectId,t.id)!;return json({task:t,messages:store.messages(t.projectId,t.id),documents:readTaskDocuments(documentFolder(store,project,t))});}catch{return json({error:'文書を読み込めませんでした'},500)} }
   return json({error:'見つかりません'},404);
  }
  if (request.method !== 'POST' || !access(request).sameOrigin || request.headers.get('content-type') !== 'application/json') return json({error:'アクセスできません'},403);
  try {
   if (Number(request.headers.get('content-length') || 0)>65536) return json({error:'入力が長すぎます'},413);
   const body = await request.text();
   if (new TextEncoder().encode(body).byteLength > 65536) return json({error:'入力が長すぎます'},413);
   const input = JSON.parse(body) as Record<string,unknown>;
   if (!input || typeof input !== 'object' || Array.isArray(input)) return json({error:'入力を確認してください'},400);
   const ackMatch=url.pathname.match(/^\/api\/chat\/packs\/([^/]+)\/ack$/);
   if(ackMatch){const p=input.projectId,t=input.taskId;if(!scope(p,t))return json({error:'会話が見つかりません'},404);const id=decodePackId(ackMatch[1]);if(!validId(id)||typeof input.hash!=='string'||! /^[a-f0-9]{64}$/.test(input.hash))return json({error:'入力を確認してください'},400);try{return json(await chat.ack(Number(p),t as number|null,id,input.hash))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if (url.pathname === '/api/chat/send' || url.pathname === '/api/chat/interrupt') {
    const p=input.projectId,t=input.taskId;const project=scope(p,t);if(!project)return json({error:'会話が見つかりません'},404);
    try {if(url.pathname.endsWith('/interrupt')){await chat.interrupt(Number(p),t as number|null);return json({ok:true})}
     if(typeof input.content!=='string'||!input.content.trim()||!(input.model===null||(typeof input.model==='string'&&input.model.length<=256)))return json({error:'入力を確認してください'},400);
     const {packs,...conversation}=await chat.send(Number(p),t as number|null,input.content,input.model as string|null,project.folder,t===null?undefined:documentFolder(store,project,projectTask(store.task(Number(t)))));return json(conversation,202);
    } catch(e) {const message=e instanceof Error?e.message:'';return json({error:message==='busy'?'送信中です':message==='unavailable'?'Codex の接続状態を確認してください':message==='unsafe configuration'?'Codex の外部ツールを無効にできませんでした':message==='not running'?'停止できる処理がありません':'保存または接続に失敗しました'},message==='busy'||message==='not running'?409:message==='unavailable'||message==='unsafe configuration'?400:500)}
   }
   if (url.pathname === '/api/folders/list') {
    const path = input.path === undefined ? initialFolder : input.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return json({error:'フォルダを確認してください'},400);
    try { return json(await listFolders(path)); }
    catch { return json({error:'フォルダを開けませんでした'},400); }
   }
   if (url.pathname === '/api/projects') {if(typeof input.name!=='string'||typeof input.folder!=='string'||!isAbsolute(input.folder)) return json({error:'名前と絶対パスを入力してください'},400);if(!input.name.trim())return json({error:'名前を入力してください'},400);projectDocuments(input.folder);return json(store.createProject(input.name,input.folder),201)}
   if (url.pathname === '/api/tasks') {if(typeof input.name!=='string'||!Number.isSafeInteger(input.projectId)||Number(input.projectId)<=0)return json({error:'タスク名とプロジェクトを確認してください'},400);const project=scope(input.projectId,null);if(!project)return json({error:'プロジェクトが見つかりません'},404);return json(projectTask(store.createTask(Number(input.projectId),input.name,task=>taskDocuments(project.folder,task.id,{requirements:'# '+task.name+'\n'},true))),201)}
   const match=url.pathname.match(/^\/api\/tasks\/(\d+)\/messages$/);
   if(match){const task=store.task(Number(match[1]));if(!task)return json({error:'タスクが見つかりません'},404);if(typeof input.content!=='string')return json({error:'入力を確認してください'},400);const t=projectTask(task);return json(store.addMessage(t.projectId,t.id,'user',input.content),201)}
   return json({error:'見つかりません'},404);
  } catch {return json({error:'入力または保存先を確認してください'},400)}
 };
}
export function createServerOptions(store:Store,initialFolder=homedir(),chat=new ChatService(dataPaths().chatDirectory),publicOrigin?:string) {
 const access=requestAccess(publicOrigin);
 const scope=(p:number,t:number|null)=>projectForScope(store,p,t);
 const websocket=communicationSocket({
  chat:{validate:s=>!!scope(s.projectId,s.taskId),subscribe:(s,event)=>chat.subscribe(s.projectId,s.taskId,event)},
  documents:{validate:s=>s.taskId!==null&&!!scope(s.projectId,s.taskId),subscribe:(s,event,failed)=>{const project=scope(s.projectId,s.taskId)!;const path=documentFolder(store,project,projectTask(store.task(s.taskId!)));let timer:ReturnType<typeof setTimeout>|undefined;const stop=watchTaskDocuments(path,()=>{if(timer===undefined)timer=setTimeout(()=>{timer=undefined;event({name:'documents.changed',data:{}})},80)},failed);return ()=>{clearTimeout(timer);stop()}}},
 });
 const handle=createHandler(store,initialFolder,chat,publicOrigin);
 return {websocket,fetch(request:Request,server:Server<SocketData>){const url=new URL(request.url);if(url.pathname!=='/api/ws')return handle(request);if(request.method!=='GET'||!access(request).allowed||!access(request).sameOrigin||request.headers.get('sec-fetch-site')==='cross-site')return new Response('Forbidden',{status:403});if(!server.upgrade(request,{data:{ready:false,used:new Set(),subscriptions:new Map()}}))return new Response('WebSocket upgrade required',{status:400});return undefined}};
}
export function dataPaths(environment: Record<string,string|undefined> = process.env, cwd = process.cwd()) {
 const dataDirectory = environment.BENI_DATA_DIR ? resolve(cwd,environment.BENI_DATA_DIR) : fileURLToPath(new URL('../../data',import.meta.url));
 const database = join(dataDirectory,'beni.sqlite');
 const chatDirectory = join(dataDirectory,'chat');
 return {dataDirectory,database,chatDirectory};
}
if (import.meta.main) {
 const {database,chatDirectory} = dataPaths();
 await mkdir(dirname(resolve(database)),{recursive:true,mode:0o700});
 const store = new Store(database);
 const chat = new ChatService(chatDirectory);
 const port = Number(process.env.BENI_PORT ?? 3210);
 const publicOrigin = process.env.BENI_PUBLIC_ORIGIN;
 const server = Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:65536,...createServerOptions(store,homedir(),chat,publicOrigin)});
 console.log(`Beni: http://127.0.0.1:${server.port}/`);
}
