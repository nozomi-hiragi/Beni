import { Store } from './store/index';
import { ChatService } from './chat';
import { TerminalService, TerminalError } from './terminal';
import { communicationSocket, type SocketData } from './events';
import type { Server } from 'bun';
import { validId } from '../shared/communication';
import { validProjectId, validTaskId } from '../shared/ids';
import { taskDocuments, readTaskDocuments, watchTaskDocuments } from './documents';
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
const documentFolder = (_store:Store,project:any, task:any) => taskDocuments(project.folder,task.id,{requirements:'# '+task.name+'\n'});
const projectResolver = (store:Store) => (projectId:string) => {
 const project=store.projects().map(row).find(project=>project.id===projectId);
 if(!project)throw Error('Project not found');
 return project.folder as string;
};
const projectForScope = (store:Store,projectId:unknown,taskId:unknown) => {
  if (!validProjectId(projectId) || (taskId!==null && !validTaskId(taskId))) return null;
  const project=store.projects().map(row).find(p=>p.id===projectId);
  if (!project) return null;
  if (taskId!==null) {const task=store.task(taskId);if(!task || row(task).project_id!==projectId)return null}
  return project;
 };
export function createHandler(store: Store, initialFolder = homedir(), chat = new ChatService(projectResolver(store)), publicOrigin?: string, terminals = new TerminalService()) {
 const access=requestAccess(publicOrigin);
 const scope=(p:unknown,t:unknown)=>projectForScope(store,p,t);
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (!access(request).allowed) return new Response('Forbidden',{status:403});
  const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if (request.method === 'GET') {
   try {
   if (url.pathname === '/' || url.pathname === '/settings' || validProjectId(url.pathname.match(/^\/project\/([^/]+)$/)?.[1]) || ['/ui/index.html','/ui/build/app.js','/ui/generated.css','/ui/style.css'].includes(url.pathname)) {
    const file = url.pathname === '/ui/build/app.js' ? '../../dist/frontend/app.js' : url.pathname === '/ui/style.css' ? '../../dist/frontend/beni.css' : url.pathname === '/ui/generated.css' ? '../../dist/frontend/generated.css' : '../frontend/index.html';
    return new Response(Bun.file(new URL(file,import.meta.url)),{headers:{'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
   }
   if (url.pathname === '/api/terminals') {const p=url.searchParams.get('projectId');if(!scope(p,null))return json({error:'プロジェクトが見つかりません'},404);return json(terminals.list(p as string))}
   if (url.pathname === '/api/codex/status') return json(await chat.status());
   const packMatch=url.pathname.match(/^\/api\/chat\/packs(?:\/([^/]+))?$/);
   if(packMatch){const p=url.searchParams.get('projectId');const raw=url.searchParams.get('taskId');const t=raw;if(!scope(p,t))return json({error:'会話が見つかりません'},404);try{const id=packMatch[1]===undefined?undefined:decodePackId(packMatch[1]);if(id!==undefined&&!validId(id))return json({error:'入力を確認してください'},400);const after=url.searchParams.get('afterPackId');if(after!==null&&!validId(after))return json({error:'入力を確認してください'},400);return json(id?await chat.pack(p as string,t,id):await chat.packs(p as string,t,url.searchParams.get('afterPackId')??undefined))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if (url.pathname === '/api/chat') {const p=url.searchParams.get('projectId');const raw=url.searchParams.get('taskId');const t=raw;if(!scope(p,t))return json({error:'会話が見つかりません'},404);try{const {packs,...conversation}=await chat.get(p as string,t);return json(conversation)}catch{return json({error:'履歴を読み込めませんでした'},500)}}
   if (url.pathname === '/api/state') return json({projects:store.projects(),tasks:store.tasks().map(projectTask)});
   const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
   if (match) { if(!validTaskId(match[1]))return json({error:'タスクが見つかりません'},404);const task=store.task(match[1]); if (!task) return json({error:'タスクが見つかりません'},404); const t=projectTask(task); try {const project=scope(t.projectId,t.id)!;return json({task:t,documents:readTaskDocuments(documentFolder(store,project,t))});}catch{return json({error:'文書を読み込めませんでした'},500)} }
   return json({error:'見つかりません'},404);
   } catch {return json({error:'保存データを読み込めませんでした'},500)}
  }
  if (request.method !== 'POST' || !access(request).sameOrigin || request.headers.get('content-type') !== 'application/json') return json({error:'アクセスできません'},403);
  try {
   if (Number(request.headers.get('content-length') || 0)>65536) return json({error:'入力が長すぎます'},413);
   const body = await request.text();
   if (new TextEncoder().encode(body).byteLength > 65536) return json({error:'入力が長すぎます'},413);
   const input = JSON.parse(body) as Record<string,unknown>;
   if (!input || typeof input !== 'object' || Array.isArray(input)) return json({error:'入力を確認してください'},400);
   if(url.pathname==='/api/terminals'||/^\/api\/terminals\/[^/]+\/close$/.test(url.pathname)){
    const project=scope(input.projectId,null);if(!project)return json({error:'プロジェクトが見つかりません'},404);
    try {if(url.pathname==='/api/terminals'){if(!validId(input.requestId))return json({error:'作成 ID を確認してください'},400);return json(terminals.create(input.projectId as string,project.folder,input.requestId),201)}
     const id=decodePackId(url.pathname.split('/')[3]);if(!validId(id)||!validId(input.controlToken))return json({error:'操作権を確認してください'},400);await terminals.close(input.projectId as string,id,input.controlToken);return json({ok:true});
    }catch(error){return error instanceof TerminalError?json({error:error.message},error.status):json({error:'ターミナルを操作できませんでした'},500)}
   }
   const ackMatch=url.pathname.match(/^\/api\/chat\/packs\/([^/]+)\/ack$/);
   if(ackMatch){const p=input.projectId,t=input.taskId;if(!scope(p,t))return json({error:'会話が見つかりません'},404);const id=decodePackId(ackMatch[1]);if(!validId(id)||typeof input.hash!=='string'||! /^[a-f0-9]{64}$/.test(input.hash))return json({error:'入力を確認してください'},400);try{return json(await chat.ack(p as string,t as string|null,id,input.hash))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if (url.pathname === '/api/chat/send' || url.pathname === '/api/chat/interrupt') {
    const p=input.projectId,t=input.taskId;const project=scope(p,t);if(!project)return json({error:'会話が見つかりません'},404);
    try {if(url.pathname.endsWith('/interrupt')){await chat.interrupt(p as string,t as string|null);return json({ok:true})}
     if(typeof input.content!=='string'||!input.content.trim()||!(input.model===null||(typeof input.model==='string'&&input.model.length<=256)))return json({error:'入力を確認してください'},400);
     const {packs,...conversation}=await chat.send(p as string,t as string|null,input.content,input.model as string|null,project.folder,t===null?undefined:documentFolder(store,project,projectTask(store.task(t as string))));return json(conversation,202);
    } catch(e) {const message=e instanceof Error?e.message:'';return json({error:message==='busy'?'送信中です':message==='unavailable'?'Codex の接続状態を確認してください':message==='unsafe configuration'?'Codex の外部ツールを無効にできませんでした':message==='not running'?'停止できる処理がありません':'保存または接続に失敗しました'},message==='busy'||message==='not running'?409:message==='unavailable'||message==='unsafe configuration'?400:500)}
   }
   if (url.pathname === '/api/folders/list') {
    const path = input.path === undefined ? initialFolder : input.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return json({error:'フォルダを確認してください'},400);
    try { return json(await listFolders(path)); }
    catch { return json({error:'フォルダを開けませんでした'},400); }
   }
   if (url.pathname === '/api/projects') {if(typeof input.name!=='string'||typeof input.folder!=='string'||!isAbsolute(input.folder)) return json({error:'名前と絶対パスを入力してください'},400);if(!input.name.trim())return json({error:'名前を入力してください'},400);return json(store.createProject(input.name,input.folder),201)}
   if (url.pathname === '/api/tasks') {if(typeof input.name!=='string'||!validProjectId(input.projectId))return json({error:'タスク名とプロジェクトを確認してください'},400);const project=scope(input.projectId,null);if(!project)return json({error:'プロジェクトが見つかりません'},404);return json(projectTask(store.createTask(input.projectId,input.name)),201)}
   return json({error:'見つかりません'},404);
  } catch(error) {if(error instanceof Error&&error.message.startsWith('Duplicate live project copy'))return json({error:'同じIDのプロジェクトが登録済みです。別プロジェクトにする場合は bun run clone:project を使って複製してください'},409);return json({error:'入力または保存先を確認してください'},400)}
 };
}
export function createServerOptions(store:Store,initialFolder=homedir(),chat=new ChatService(projectResolver(store)),publicOrigin?:string, terminals=new TerminalService()) {
 const access=requestAccess(publicOrigin);
 const scope=(p:string,t:string|null)=>projectForScope(store,p,t);
 const websocket=communicationSocket({
  terminal:{validate:s=>s.taskId===null&&!!scope(s.projectId,null)&&(s.terminalId===undefined||terminals.has(s.projectId,s.terminalId)),subscribe:(s,event)=>terminals.subscribe(s,event)},
  chat:{validate:s=>s.terminalId===undefined&&!!scope(s.projectId,s.taskId),subscribe:(s,event)=>chat.subscribe(s.projectId,s.taskId,event)},
  documents:{validate:s=>s.terminalId===undefined&&s.taskId!==null&&!!scope(s.projectId,s.taskId),subscribe:(s,event,failed)=>{const project=scope(s.projectId,s.taskId)!;const path=documentFolder(store,project,projectTask(store.task(s.taskId!)));let timer:ReturnType<typeof setTimeout>|undefined;const stop=watchTaskDocuments(path,()=>{if(timer===undefined)timer=setTimeout(()=>{timer=undefined;event({name:'documents.changed',data:{}})},80)},failed);return ()=>{clearTimeout(timer);stop()}}},
 });
 const handle=createHandler(store,initialFolder,chat,publicOrigin,terminals);
 return {websocket,fetch(request:Request,server:Server<SocketData>){const url=new URL(request.url);if(url.pathname!=='/api/ws')return handle(request);if(request.method!=='GET'||!access(request).allowed||!access(request).sameOrigin||request.headers.get('sec-fetch-site')==='cross-site')return new Response('Forbidden',{status:403});if(!server.upgrade(request,{data:{ready:false,used:new Set(),subscriptions:new Map()}}))return new Response('WebSocket upgrade required',{status:400});return undefined}};
}
export function dataPaths(environment: Record<string,string|undefined> = process.env, cwd = process.cwd()) {
 const dataDirectory = environment.BENI_DATA_DIR ? resolve(cwd,environment.BENI_DATA_DIR) : fileURLToPath(new URL('../../data',import.meta.url));
 const database = join(dataDirectory,'beni.sqlite');
 const chatDirectory = join(dataDirectory,'chat');
 return {dataDirectory,database,chatDirectory};
}
if (import.meta.main) {
 const {database} = dataPaths();
 await mkdir(dirname(resolve(database)),{recursive:true,mode:0o700});
 const store = new Store(database);
 const chat = new ChatService(projectResolver(store));
 const terminals = new TerminalService();
 const port = Number(process.env.BENI_PORT ?? 3210);
 const publicOrigin = process.env.BENI_PUBLIC_ORIGIN;
 const server = Bun.serve({hostname:'127.0.0.1',port,maxRequestBodySize:65536,...createServerOptions(store,homedir(),chat,publicOrigin,terminals)});
 let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await terminals.dispose();await server.stop(true);store.close();process.exit(0)};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 console.log(`Beni: http://127.0.0.1:${server.port}/`);
}
