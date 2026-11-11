import { instructionKeys, isInstructionKey, type InstructionKey } from './instructions';
import { Store } from './store/index';
import { ChatService, ModelUnavailable } from './chat';
import { createAgents } from './agents';
import { TerminalService, TerminalError } from './terminal';
import { communicationSocket, type SocketData } from './events';
import type { Server } from 'bun';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { INSTRUCTIONS_CHAT_ID, validId, isProvider, type Provider } from '../shared/communication';
import { validProjectId, validTaskId } from '../shared/ids';
import { implementationPlanReady } from './documents';
import { DocumentWorkflow } from './document-workflow';
import { ManualTools, ManualToolRequestError, manualToolQueryScope } from './manual-tools';
import { listProjectFiles, readProjectFile, validProjectFilePath } from './project-files';
import type { DocumentVersion } from './document-table';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, opendir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const maxListedFolders = 500;
const maxRequestBodyBytes = 65536;
// JSON の Unicode エスケープは本文の UTF-8 1 byte あたり最大 6 bytes。キー等の分も確保する。
const maxInstructionApplyBodyBytes = maxRequestBodyBytes * 6 + 1024;
// update_instruction は本文と競合確認用の旧本文を同じリクエストで送る。
const maxManualToolBodyBytes = maxRequestBodyBytes * 2 * 6 + 4096;
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
const validChatPhase=(taskId:unknown,phase:unknown)=>taskId===null?phase==null:isTaskPhase(phase);
const chatPhase=(taskId:unknown,phase:unknown):TaskPhase|null=>taskId===null?null:phase as TaskPhase;
const decodePackId=(value:string)=>{try{return decodeURIComponent(value)}catch{return null}};
const documentVersionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const managedDocumentName = /^[a-z][a-z0-9-]{0,251}\.md$/;

function documentProvenance({revision, items}: DocumentVersion) {
 let end = 0;
 const ranges = [];
 for (const item of items) {
  const start = end;
  end += item.text.length;
  if (item.reason || item.sources.length) ranges.push({id:item.id,start,end});
 }
 return ranges.length ? {revision,items:ranges} : undefined;
}

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
const projectTask = (value: unknown) => { const t = row(value); return {id:t.id, projectId:t.project_id, name:t.name, phase:t.phase, status:t.status, createdAt:t.createdAt, updatedAt:t.updatedAt}; };
const documentFolder = (store:Store,project:any, task:any) => store.taskDocumentFolder(project.id,task.id);
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
export function createHandler(store: Store, initialFolder = homedir(), chat = new ChatService(projectResolver(store),createAgents()), publicOrigin?: string, terminals = new TerminalService(), taskEventsChanged:(p:string,t:string)=>void=()=>{}, documentsChanged:(p:string,t:string)=>void=()=>{}) {
 const changed=(p:string,t:string)=>{taskEventsChanged(p,t);documentsChanged(p,t)};
 const workflow=new DocumentWorkflow(store,chat,projectResolver(store),changed,()=>chat.notifyInstructionChanges());
 const manualTools=new ManualTools(store,chat,workflow);
 chat.setWorkflowTools(workflow);
 workflow.kickJobs();
 chat.setInstructions(()=>store.instructions());
 chat.setInstructionEditor({directory:store.dataDirectory,update:(key,content,expected)=>store.updateInstruction(key,content,expected)});
 chat.setUsageDirectory(store.dataDirectory);
 chat.setExecutionFinished((p,t)=>{
  const task=store.task(t);
  if(task?.phase!=='execution'||task.status==='completed')return;
  store.selectTaskPhase(p,t,'execution','retrospective');
  changed(p,t);
  void workflow.runReview(p,t).catch(()=>{});
 });
 chat.setFinalizationFinished(async(p,t,started)=>{
  const task=store.task(t);
  if(task?.phase!=='finalization'||task.status!=='idle')return;
  if(started&&await workflow.complete(p,t)){
   store.setTaskCompleted(p,t,true,'finalization');
   workflow.kickJobs();
  }else{
   store.rollbackTaskFinalization(p,t);
  }
  changed(p,t);
 });
 chat.setTaskActivity((p,t)=>store.touchTask(p,t));
 chat.setTaskEvents({
  capture:(p,t,phase,operationId)=>store.captureTaskHistory(p,t,phase,operationId),
  events:(p,t,after,through,limit,types)=>store.projectEvents(p,{
   after,through,limit,taskId:t??undefined,types,modelPage:types!==undefined
  }),
  event:(p,id)=>store.projectEvent(p,id),change:(p,id)=>store.projectFileChange(p,id),version:(p,path,id)=>store.projectFileVersion(p,path,id),
  append:(p,input)=>{const event=store.recordProjectEvent(p,input);if(event.taskId!==null)taskEventsChanged(p,event.taskId);return event}
 });
 const chatScope=(p:unknown,t:unknown)=>p===INSTRUCTIONS_CHAT_ID&&t===null?{folder:store.dataDirectory}:projectForScope(store,p,t);
 const access=requestAccess(publicOrigin);
 const scope=(p:unknown,t:unknown)=>projectForScope(store,p,t);
 const taskKnowledge=(task:ReturnType<typeof projectTask>, revision?:string)=>
  task.phase==='finalization' ? store.managedDocument(task.projectId,null,'knowledge.md',
   task.status==='completed' ? revision : undefined) : undefined;
 const recoverTask=async (task:ReturnType<typeof projectTask>, opened=false)=>{
  if(task.phase==='execution'&&!workflow.isExecutionContinuing(task.id))await chat.recoverExecution(task.projectId,task.id);
  if(task.phase==='finalization'&&task.status==='idle')await chat.recoverFinalization(task.projectId,task.id);
  if(task.phase==='retrospective'&&task.status==='idle'){
   const review=workflow.review(task.projectId,task.id);
   if(opened||review?.state==='pending'||review?.state==='running')void workflow.runReview(task.projectId,task.id).catch(()=>{});
  }
 };
 const chatBlocked=(taskId:string, phase:unknown)=>{
  const task=store.task(taskId)!;
  const review=task.phase==='retrospective'?workflow.review(task.project_id,taskId):null;
  return phase==='finalization'||task.phase==='finalization'||task.phase==='execution'||task.status==='completed'||review?.state==='running'||review?.state==='pending';
 };
 return async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (!access(request).allowed) return new Response('Forbidden',{status:403});
  const agentId=url.pathname.match(/^\/api\/agents\/([a-z0-9][a-z0-9-]{0,127})\/status$/)?.[1];
  const json = (value: unknown, status = 200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if (request.method === 'GET') {
   try {
   if (url.pathname === '/' || url.pathname === '/settings' || url.pathname === '/instructions' || validProjectId(url.pathname.match(/^\/project\/([^/]+)$/)?.[1]) || ['/ui/index.html','/ui/build/app.js','/ui/generated.css','/ui/style.css'].includes(url.pathname)) {
    const file = url.pathname === '/ui/build/app.js' ? '../../dist/frontend/app.js' : url.pathname === '/ui/style.css' ? '../../dist/frontend/beni.css' : url.pathname === '/ui/generated.css' ? '../../dist/frontend/generated.css' : '../frontend/index.html';
    return new Response(Bun.file(new URL(file,import.meta.url)),{headers:{'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
   }
   if (url.pathname === '/api/project-files' || url.pathname === '/api/project-file') {
    const { searchParams } = url;
    const preview = url.pathname === '/api/project-file';
    const project = scope(searchParams.get('projectId'), null);
    if (!project) return json({error:'プロジェクトが見つかりません'},404);
    const path = searchParams.get('path') ?? '';
    if (!validProjectFilePath(path) || (preview && !path) || ['projectId','path'].some(key => searchParams.getAll(key).length > 1)) {
     return json({error:'パスを確認してください'},400);
    }
    try {
     return json(await (preview ? readProjectFile(project.folder, path) : listProjectFiles(project.folder, path)));
    } catch {
     return json({error:preview ? 'ファイルを読み込めませんでした' : 'フォルダーを開けませんでした'},404);
    }
   }
   if (url.pathname === '/api/terminals') {const p=url.searchParams.get('projectId');if(!scope(p,null))return json({error:'プロジェクトが見つかりません'},404);return json(terminals.list(p as string))}
   if (url.pathname === '/api/tools') return json(manualTools.catalog(manualToolQueryScope(url.searchParams)));
   const toolOperation = url.pathname.match(/^\/api\/tools\/operations\/([^/]+)$/);
   if (toolOperation) return json({operation:manualTools.operation(manualToolQueryScope(url.searchParams),toolOperation[1]!)});
   if (url.pathname === '/api/instructions') {
    const editorState = await chat.instructionEditorState();
    const versions = instructionKeys.map(key => ({key,version:store.instructionDocument(key)!}));
    const instructions = versions.map(({key,version}) => ({key,content:version.content}));
    const provenance = Object.fromEntries(versions.flatMap(({key,version}) => {
     const summary = documentProvenance(version);
     return summary ? [[key,summary]] : [];
    }));
    return json({instructions,editorState,provenance});
   }
   if (url.pathname === '/api/document-provenance') {
    const {searchParams} = url;
    const name = searchParams.get('name'), revision = searchParams.get('revision'), itemId = searchParams.get('itemId');
    const projectId = searchParams.get('projectId'), taskId = searchParams.get('taskId');
    const invalid = () => json({error:'入力を確認してください'},400);
    const missing = () => json({error:'文書の根拠が見つかりません'},404);
    if (!name || !revision || !itemId || !documentVersionId.test(revision) || !documentVersionId.test(itemId)
        || ['name','revision','itemId','projectId','taskId'].some(key => searchParams.getAll(key).length > 1)) return invalid();

    let version: DocumentVersion | undefined;
    let taskName: string | undefined;
    let projectName: string | undefined;
    if (projectId === null && taskId === null) {
     if (!isInstructionKey(name)) return invalid();
     version = store.instructionDocument(name,revision);
    } else {
     if (!validProjectId(projectId) || !validTaskId(taskId) || !managedDocumentName.test(name)) return invalid();
     const project = scope(projectId,taskId);
     if (!project) return missing();
     projectName = project.name;
     if (name === 'knowledge.md') {
      const task = projectTask(store.task(taskId));
      const knowledge = taskKnowledge(task,store.instructionJob(projectId,taskId)?.revision);
      if (knowledge && knowledge.revision !== revision) return missing();
      version = knowledge;
     } else taskName = store.task(taskId)?.name;
     version ??= store.managedDocument(projectId,taskId,name,revision);
    }
    const item = version?.items.find(item => item.id === itemId);
    if (!item || (!item.reason && !item.sources.length)) return missing();
    const sources = item.sources.map(source => {
     if (!projectName || !projectId || source.kind === 'instruction') return source;
     const [sourceName, sourceItem] = source.id.split('/');
     if (sourceName === 'knowledge.md') {
      if (source.kind !== 'document' || !source.revision || !sourceItem) return source;
      const knowledge = store.managedDocument(projectId,null,sourceName,source.revision);
      return knowledge?.items.some(item => item.id === sourceItem) ? {...source, projectName} : source;
     }
     return taskName ? {...source, projectName, taskName} : source;
    });
    return json({reason:item.reason,sources});
   }
   if (url.pathname === '/api/agents') return json({agents:chat.agentList()});
   if (agentId) return chat.hasAgent(agentId)?json(await chat.agentStatus(agentId)):json({error:'接続先が見つかりません'},404);
   if (url.pathname === '/api/codex/status') return json(await chat.status());
   if (url.pathname === '/api/claude/status') return json(await chat.claudeStatus());
   const packMatch=url.pathname.match(/^\/api\/chat\/packs(?:\/([^/]+))?$/);
   if(packMatch){const p=url.searchParams.get('projectId');const raw=url.searchParams.get('taskId');const t=raw;if(!chatScope(p,t))return json({error:'会話が見つかりません'},404);const phase=url.searchParams.get('phase');if(!validChatPhase(t,phase)||(p===INSTRUCTIONS_CHAT_ID&&phase!==null))return json({error:'フェーズを確認してください'},400);try{const id=packMatch[1]===undefined?undefined:decodePackId(packMatch[1]);if(id!==undefined&&!validId(id))return json({error:'入力を確認してください'},400);const after=url.searchParams.get('afterPackId');if(after!==null&&!validId(after))return json({error:'入力を確認してください'},400);return json(id?await chat.pack(p as string,t,id,chatPhase(t,phase)):await chat.packs(p as string,t,url.searchParams.get('afterPackId')??undefined,chatPhase(t,phase)))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if (url.pathname === '/api/chat') {const p=url.searchParams.get('projectId');const raw=url.searchParams.get('taskId');const t=raw;if(!chatScope(p,t))return json({error:'会話が見つかりません'},404);const phase=url.searchParams.get('phase');if(!validChatPhase(t,phase)||(p===INSTRUCTIONS_CHAT_ID&&phase!==null))return json({error:'フェーズを確認してください'},400);try{const {packs,...conversation}=await chat.get(p as string,t,chatPhase(t,phase));return json(conversation)}catch{return json({error:'履歴を読み込めませんでした'},500)}}
   if (url.pathname === '/api/state') {for(const task of store.tasks().map(projectTask))await recoverTask(task);return json({projects:store.projects(),tasks:store.tasks().map(projectTask)})}
   const eventMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)\/events(?:\/versions\/([^/]+))?$/);
   if(eventMatch){
    const p=url.searchParams.get('projectId'),t=eventMatch[1]!;if(!validTaskId(t)||!scope(p,null))return json({error:'タスクが見つかりません'},404);
    try {
     if(eventMatch[2]!==undefined){if(!/^[a-f0-9]{64}$/.test(eventMatch[2]))return json({error:'版を確認してください'},400);return json(store.taskEventVersion(p as string,t,eventMatch[2]))}
     const integer=(name:string,fallback?:number)=>{const value=url.searchParams.get(name);if(value===null)return fallback;if(!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('invalid cursor');return Number(value)};
     const after=integer('after',0)!,through=integer('through'),limit=integer('limit',100)!;if(limit<1||limit>100||(through!==undefined&&after>through))return json({error:'取得範囲を確認してください'},400);
     return json(store.taskEvents(p as string,t,after,through,limit));
    }catch(error){const message=error instanceof Error?error.message:'';return json({error:'変更履歴を取得できませんでした'},message==='invalid cursor'?400:message.includes('not found')||message.includes('Unknown')?404:500)}
   }
   const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
   if (match) { if(!validTaskId(match[1]))return json({error:'タスクが見つかりません'},404);const task=store.task(match[1]); if (!task) return json({error:'タスクが見つかりません'},404); const t=projectTask(task); try {await recoverTask(t,true);
     const latest=projectTask(store.task(t.id));
     const instructionJob=store.instructionJob(t.projectId,t.id);
     const versions=store.managedDocuments(t.projectId,t.id);
     const knowledge=taskKnowledge(latest,instructionJob?.revision);
     const documents=(knowledge?[...versions.filter(doc=>doc.name!=='knowledge.md'),knowledge]:versions)
      .map(doc=>({name:doc.name,path:doc.name,content:doc.content,version:doc.updatedAt,provenance:documentProvenance(doc)}));
     return json({task:latest,documents,canStart:implementationPlanReady(documents),workflow:{
      review:latest.phase==='retrospective'?workflow.review(t.projectId,t.id):null,
      instructionJob
     }});}catch{return json({error:'文書を読み込めませんでした'},500)} }
   return json({error:'見つかりません'},404);
   } catch(error) {return error instanceof ManualToolRequestError?json({error:error.message},error.status):json({error:'保存データを読み込めませんでした'},500)}
  }
  if (request.method !== 'POST' || !access(request).sameOrigin || request.headers.get('content-type') !== 'application/json') return json({error:'アクセスできません'},403);
  try {
   const bodyLimit = url.pathname === '/api/tools' ? maxManualToolBodyBytes :
    url.pathname === '/api/instructions/apply' ? maxInstructionApplyBodyBytes : maxRequestBodyBytes;
   if (Number(request.headers.get('content-length') || 0)>bodyLimit) return json({error:'入力が長すぎます'},413);
   const body = await request.text();
   if (new TextEncoder().encode(body).byteLength > bodyLimit) return json({error:'入力が長すぎます'},413);
   const input = JSON.parse(body) as Record<string,unknown>;
   if (!input || typeof input !== 'object' || Array.isArray(input)) return json({error:'入力を確認してください'},400);
   if (url.pathname === '/api/tools') {
    try {
     const result=manualTools.accept(input);
     return json({operation:result.operation},result.status);
    } catch (error) {
     if (error instanceof ManualToolRequestError) return json({error:error.message},error.status);
     return json({error:'操作を受け付けられませんでした'},500);
    }
   }
   if (agentId) {
    if (Object.keys(input).length) return json({error:'入力を確認してください'},400);
    return chat.hasAgent(agentId)?json(await chat.refreshAgentUsage(agentId)):json({error:'接続先が見つかりません'},404);
   }
   if (url.pathname === '/api/codex/status' || url.pathname === '/api/claude/status') {
    if (Object.keys(input).length) return json({error:'入力を確認してください'},400);
    return json(await chat.refreshUsage(url.pathname === '/api/codex/status' ? 'codex' : 'claude'));
   }
   if(url.pathname==='/api/instructions/apply'){
    if(typeof input.expected_content!=='string'||Object.keys(input).some(key=>key!=='expected_content'))return json({error:'入力を確認してください'},400);
    try{return json({editorState:await chat.applyInstructionEditor(input.expected_content)})}catch(error){const message=error instanceof Error?error.message:'';return json({error:message==='busy'?'生成中は反映できません':message==='conflict'?'インストラクションが変更されています':'反映できませんでした'},message==='busy'||message==='conflict'?409:500)}
   }
   if(url.pathname==='/api/terminals'||/^\/api\/terminals\/[^/]+\/close$/.test(url.pathname)){
    const project=scope(input.projectId,null);if(!project)return json({error:'プロジェクトが見つかりません'},404);
    try {if(url.pathname==='/api/terminals'){if(!validId(input.requestId))return json({error:'作成 ID を確認してください'},400);return json(terminals.create(input.projectId as string,project.folder,input.requestId),201)}
     const id=decodePackId(url.pathname.split('/')[3]);if(!validId(id)||!validId(input.controlToken))return json({error:'操作権を確認してください'},400);await terminals.close(input.projectId as string,id,input.controlToken);return json({ok:true});
    }catch(error){return error instanceof TerminalError?json({error:error.message},error.status):json({error:'ターミナルを操作できませんでした'},500)}
   }
   const ackMatch=url.pathname.match(/^\/api\/chat\/packs\/([^/]+)\/ack$/);
   if(ackMatch){const p=input.projectId,t=input.taskId??null;if(!chatScope(p,t))return json({error:'会話が見つかりません'},404);if(!validChatPhase(t,input.phase)||(p===INSTRUCTIONS_CHAT_ID&&input.phase!==undefined))return json({error:'フェーズを確認してください'},400);const id=decodePackId(ackMatch[1]);if(!validId(id)||typeof input.hash!=='string'||! /^[a-f0-9]{64}$/.test(input.hash))return json({error:'入力を確認してください'},400);try{return json(await chat.ack(p as string,t as string|null,id,input.hash,chatPhase(t,input.phase)))}catch(error){const m=error instanceof Error?error.message:'';return json({error:m==='not found'?'パックが見つかりません':m==='not closed'?'生成中のパックです':'パックを読み込めませんでした'},m==='not found'?404:m==='not closed'?409:500)}}
   if(url.pathname==='/api/chat/context-usage'){
    const p=input.projectId,t=input.taskId??null,project=chatScope(p,t);
    if(!project)return json({error:'会話が見つかりません'},404);
    if(!validChatPhase(t,input.phase)||(p===INSTRUCTIONS_CHAT_ID&&input.phase!==undefined))return json({error:'フェーズを確認してください'},400);
    if(!isProvider(input.provider)||typeof input.model!=='string'||!input.model.trim()||input.model.length>256||
     (input.refresh!==undefined&&typeof input.refresh!=='boolean')||Object.keys(input).some(key=>!['projectId','taskId','phase','provider','model','refresh'].includes(key)))return json({error:'モデルを確認してください'},400);
    const scopeCurrent=()=>t===null?!!chatScope(p,t):store.task(t as string)?.phase===input.phase&&!chatBlocked(t as string,input.phase);
    if(!scopeCurrent())return json({});
    try{
     const contextUsage=await chat.getContextUsage(p as string,t as string|null,chatPhase(t,input.phase),input.provider,input.model,project.folder,{refresh:input.refresh===true,scopeCurrent});
     return json({contextUsage});
    }catch{return json({error:'コンテキストの使用量を取得できませんでした'},500)}
   }
   if(url.pathname==='/api/chat/commands'){
    const p=input.projectId,t=input.taskId??null,project=chatScope(p,t);if(!project)return json({error:'会話が見つかりません'},404);
    if(!validChatPhase(t,input.phase)||(p===INSTRUCTIONS_CHAT_ID&&input.phase!==undefined))return json({error:'フェーズを確認してください'},400);
    if(typeof input.command!=='string'||(input.args!==undefined&&typeof input.args!=='string')||(typeof input.args==='string'&&input.args.length>16384)||(input.provider!==undefined&&!isProvider(input.provider))||(input.model!==undefined&&input.model!==null&&(typeof input.model!=='string'||input.model.length>256))||Object.keys(input).some(key=>!['projectId','taskId','phase','command','args','provider','model'].includes(key)))return json({error:'コマンドを確認してください'},400);
    if(t!==null&&chatBlocked(t as string,input.phase))return json({error:'現在のタスクには送信できません'},409);
    if(t!==null&&store.task(t as string)!.phase!==input.phase)return json({error:'フェーズが変更されています'},409);
    try{return json(await chat.command(p as string,t as string|null,input.command,project.folder,t===null?undefined:documentFolder(store,project,projectTask(store.task(t as string))),chatPhase(t,input.phase),{args:input.args as string|undefined,provider:input.provider as Provider|undefined,model:input.model as string|null|undefined}),202)}catch(error){const message=error instanceof Error?error.message:'';return json({error:message==='busy'?'送信中です':message==='no thread'?'この接続先とモデルで操作できる会話がありません':message==='invalid command'?'この接続先ではコマンドを利用できません':message==='unavailable'?'接続状態を確認してください':'コマンドを開始できませんでした'},['busy','no thread'].includes(message)?409:['unavailable','invalid command'].includes(message)?400:500)}
   }
   if (url.pathname === '/api/chat/send' || url.pathname === '/api/chat/interrupt') {
    const p=input.projectId,t=input.taskId??null;const project=chatScope(p,t);if(!project)return json({error:'会話が見つかりません'},404);
    if(!validChatPhase(t,input.phase)||(p===INSTRUCTIONS_CHAT_ID&&input.phase!==undefined))return json({error:'フェーズを確認してください'},400);
    if(t!==null&&chatBlocked(t as string,input.phase))return json({error:'現在のタスクには送信できません'},409);
    try {if(url.pathname.endsWith('/interrupt')){await chat.interrupt(p as string,t as string|null,chatPhase(t,input.phase));return json({ok:true})}
     if((p===INSTRUCTIONS_CHAT_ID&&!isInstructionKey(input.instructionFocus))||(input.provider!==undefined&&!isProvider(input.provider))||typeof input.content!=='string'||!input.content.trim()||!(input.model===null||(typeof input.model==='string'&&input.model.length<=256)))return json({error:'入力を確認してください'},400);
     if(t!==null&&store.task(t as string)!.phase!==input.phase)return json({error:'フェーズが変更されています'},409);
     const {packs,...conversation}=await chat.send(p as string,t as string|null,input.content,input.model as string|null,project.folder,t===null?undefined:documentFolder(store,project,projectTask(store.task(t as string))),chatPhase(t,input.phase),false,input.provider as Provider|undefined,input.instructionFocus as InstructionKey|undefined);return json(conversation,202);
    } catch(e) {const message=e instanceof Error?e.message:'';return json({...(e instanceof ModelUnavailable ? {code:'MODEL_UNAVAILABLE'} : {}),error:e instanceof ModelUnavailable?'選択したモデルを利用できません':message==='chat command arguments'?'クラウド実行やコメント投稿の引数は利用できません':message==='chat command'?'スラッシュコマンドはコマンド API を使ってください':message==='busy'?'送信中です':message==='unavailable'?`${chat.agentName(isProvider(input.provider)?input.provider:undefined)} の接続状態を確認してください`:message==='not running'?'停止できる処理がありません':'保存または接続に失敗しました'},message==='busy'||message==='not running'?409:e instanceof ModelUnavailable||message==='chat command'||message==='chat command arguments'||message==='unavailable'?400:500)}
   }
   if (url.pathname === '/api/folders/list') {
    const path = input.path === undefined ? initialFolder : input.path;
    if (typeof path !== 'string' || !isAbsolute(path)) return json({error:'フォルダを確認してください'},400);
    try { return json(await listFolders(path)); }
    catch { return json({error:'フォルダを開けませんでした'},400); }
   }
   if (url.pathname === '/api/projects') {if(typeof input.name!=='string'||typeof input.folder!=='string'||!isAbsolute(input.folder)) return json({error:'名前と絶対パスを入力してください'},400);if(!input.name.trim())return json({error:'名前を入力してください'},400);return json(store.createProject(input.name,input.folder),201)}
   const phaseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(phase|start|stop|complete|reopen)$/);
   if (phaseMatch) {
    if (!isTaskPhase(input.phase) || !validProjectId(input.projectId) || (phaseMatch[2]==='phase'&&(!isTaskPhase(input.target)||!['requirements','documents','implementation'].includes(input.target)))) return json({error:'フェーズを確認してください'},400);
    const taskId=phaseMatch[1]!, projectId=input.projectId, expectedPhase=input.phase;
    if(phaseMatch[2]==='start'&&((input.provider!==undefined&&(!isProvider(input.provider)||!chat.hasAgent(input.provider)))||!(input.model===null||(typeof input.model==='string'&&input.model.length<=256))))return json({error:'入力を確認してください'},400);
    const project=validTaskId(taskId)?scope(projectId,taskId):null;
    if (!project) return json({error:'タスクが見つかりません'},404);
    const action=phaseMatch[2];
    try {
     const change=()=>{
      const task=store.task(taskId)!;
      if(task.phase!==expectedPhase||task.status==='completed'||task.phase==='finalization')throw Error('phase conflict');
      if(action==='phase'&&input.phase==='retrospective')throw Error('phase conflict');
      if(action==='start'&&input.phase==='retrospective')throw Error('phase conflict');
      if((action==='stop')!==(input.phase==='execution'))throw Error('phase conflict');
      if(action==='start'&&!implementationPlanReady(store.managedDocuments(projectId,taskId)))throw Error('plan required');
      return store.selectTaskPhase(projectId,taskId,expectedPhase,action==='start'?'execution':action==='stop'?'implementation':input.target as TaskPhase);
     };
     let task;
     if(action==='complete'){
      if(workflow.review(projectId,taskId)?.state!=='done')throw Error('review pending');
      const current=store.task(taskId)!;
      if(expectedPhase!=='retrospective'||current.phase!==expectedPhase||current.status!=='idle')throw Error('phase conflict');
      task=await chat.startFinalization(projectId,taskId,()=>{
       const next=store.startTaskFinalization(projectId,taskId);
       taskEventsChanged(projectId,taskId);
       return next;
      },()=>{
       store.rollbackTaskFinalization(projectId,taskId);
       taskEventsChanged(projectId,taskId);
      },project.folder,store.taskDocumentFolder(projectId,taskId));
     }else if(action==='reopen'){
      task=chat.withIdleTask(projectId,taskId,()=>store.setTaskCompleted(projectId,taskId,false,expectedPhase));
     }else if(action==='start'){
      task=await chat.startTask(projectId,taskId,change,()=>{if(store.task(taskId)?.phase==='execution'){store.selectTaskPhase(projectId,taskId,'execution',expectedPhase);taskEventsChanged(projectId,taskId)}},input.model as string|null,project.folder,store.taskDocumentFolder(projectId,taskId),input.provider as Provider|undefined);
     }else if(action==='stop'){
      task=await chat.stopTask(projectId,taskId,change,()=>{if(expectedPhase!=='execution'||store.task(taskId)!.phase!==expectedPhase)throw Error('phase conflict')});
     }else{
      task=chat.withIdleTask(projectId,taskId,change);
     }
     if(action==='phase'&&task.phase!==expectedPhase&&(task.phase==='documents'||task.phase==='implementation')){
      try{await workflow.prepare(projectId,taskId,task.phase)}catch{ /* 新しいフェーズのチャットからやり直せる。 */ }
     }
     if(action!=='complete')taskEventsChanged(projectId,taskId);
     return json(projectTask(task));
    } catch (error) {
     const message = error instanceof Error ? error.message : '';
     const unavailable=action==='complete'?'終了に使うモデルの接続状態を確認してください':`${chat.agentName(isProvider(input.provider)?input.provider:undefined)} の接続状態を確認してください`;
     return json({...(error instanceof ModelUnavailable ? {code:'MODEL_UNAVAILABLE'} : {}),error:error instanceof ModelUnavailable?'選択したモデルを利用できません':message === 'busy' ? 'チャットの処理中はフェーズを変更できません' : message === 'phase conflict' ? 'フェーズが変更されています' : message==='plan required'?'実装手順を作成してください':message==='review pending'?'反省会の分析を完了してください':message==='unavailable'?unavailable:'フェーズを保存できませんでした'}, ['busy','phase conflict','plan required','review pending'].includes(message) ? 409 : error instanceof ModelUnavailable||message==='unavailable'?400:500);
    }
   }

   const reviewAction=url.pathname.match(/^\/api\/tasks\/([^/]+)\/(stop-review|retry-review)$/);
   if(reviewAction){
    const t=reviewAction[1]!,p=input.projectId,stop=reviewAction[2]==='stop-review';
    if(!validProjectId(p)||!scope(p,t))return json({error:'タスクが見つかりません'},404);
    try{
     if(stop)await workflow.stopReview(p,t);
     else workflow.retryReview(p,t);
     return json({ok:true},stop?200:202);
    }catch(error){
     const message=error instanceof Error?error.message:'';
     if(message==='busy'||message==='review unavailable')return json({error:stop?'停止できる分析がありません':'現在は分析を再試行できません'},409);
     return json({error:stop?'分析を停止できませんでした':'分析を再試行できませんでした'},500);
    }
   }
   const retry=url.pathname.match(/^\/api\/tasks\/([^/]+)\/retry-instructions$/);
   if(retry){
    const t=retry[1]!,p=input.projectId;
    if(!validProjectId(p)||!scope(p,t))return json({error:'タスクが見つかりません'},404);
    const task=store.task(t)!;
    if(task.status!=='completed'||store.instructionJob(p,t)?.status!=='failed')return json({error:'再試行できる指示更新がありません'},409);
    if (chat.manualToolBusy(p,t) || chat.manualToolBusy(INSTRUCTIONS_CHAT_ID,null)) return json({error:'ツールの処理中は再試行できません'},409);
    store.retryInstructionJob(p,t);
    workflow.kickJobs();
    changed(p,t);
    return json({ok:true},202);
   }
   const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/delete$/);
   if (deleteMatch) {
    if (!validTaskId(deleteMatch[1]) || !scope(input.projectId, deleteMatch[1])) return json({error:'タスクが見つかりません'},404);
    try { chat.deleteTask(input.projectId as string, deleteMatch[1]!, () => store.deleteTask(input.projectId as string, deleteMatch[1]!)); taskEventsChanged(input.projectId as string,deleteMatch[1]!); return json({ok:true}); }
    catch (error) { return error instanceof Error && error.message === 'busy' ? json({error:'チャットの処理中は削除できません'},409) : json({error:'タスクを削除できませんでした'},500); }
   }
   const renameMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rename$/);
   if (renameMatch) {
    if (typeof input.name !== 'string' || !input.name.trim()) return json({error:'タスク名を入力してください'},400);
    if (!validTaskId(renameMatch[1]) || !scope(input.projectId, renameMatch[1])) return json({error:'タスクが見つかりません'},404);
    if (chat.manualToolBusy(input.projectId as string,renameMatch[1]!)) return json({error:'ツールの処理中は名前を変更できません'},409);
    try { const task=store.renameTask(input.projectId as string, renameMatch[1]!, input.name); taskEventsChanged(input.projectId as string,renameMatch[1]!); return json(projectTask(task)); }
    catch { return json({error:'タスク名を保存できませんでした'},500); }
   }
   if (url.pathname === '/api/tasks') {if(typeof input.name!=='string'||!validProjectId(input.projectId))return json({error:'タスク名とプロジェクトを確認してください'},400);const project=scope(input.projectId,null);if(!project)return json({error:'プロジェクトが見つかりません'},404);return json(projectTask(store.createTask(input.projectId,input.name)),201)}
   return json({error:'見つかりません'},404);
  } catch(error) {if(error instanceof Error&&error.message.startsWith('Duplicate live project copy'))return json({error:'同じIDのプロジェクトが登録済みです'},409);return json({error:'入力または保存先を確認してください'},400)}
 };
}
export function createServerOptions(store:Store,initialFolder=homedir(),chat=new ChatService(projectResolver(store),createAgents()),publicOrigin?:string, terminals=new TerminalService()) {
 const eventListeners=new Map<string,Set<(event:any)=>void>>();
 const documentListeners=new Map<string,Set<(event:any)=>void>>();
 const notifyDocuments=(p:string,t:string)=>{for(const listener of documentListeners.get(JSON.stringify([p,t]))??[])listener({name:'documents.changed',data:{}})};
 const notifyTaskEvents=(p:string,t:string)=>{const cursor=store.projectEventCursor(p);for(const listener of eventListeners.get(JSON.stringify([p,t]))??[])listener({name:'task.events.changed',data:{lastEventId:cursor}})};
 const access=requestAccess(publicOrigin);
 const scope=(p:string,t:string|null)=>projectForScope(store,p,t);
 const websocket=communicationSocket({
  'task-events':{
   validate:s=>s.phase===undefined&&s.terminalId===undefined&&s.taskId!==null&&!!scope(s.projectId,null),
   subscribe:(s,event,failed)=>{
    const t=s.taskId!,k=JSON.stringify([s.projectId,t]);
    const task=store.task(t),live=task?.project_id===s.projectId;
    const listeners=eventListeners.get(k)??new Set();
    eventListeners.set(k,listeners);listeners.add(event);
    return {
     start:()=>{try{if(live)store.captureTaskHistory(s.projectId,t);notifyTaskEvents(s.projectId,t)}catch{failed()}},
     stop:()=>{listeners.delete(event);if(!listeners.size)eventListeners.delete(k)}
    };
   }
  },
  terminal:{validate:s=>s.phase===undefined&&s.taskId===null&&!!scope(s.projectId,null)&&(s.terminalId===undefined||terminals.has(s.projectId,s.terminalId)),subscribe:(s,event)=>terminals.subscribe(s,event)},
  chat:{validate:s=>s.terminalId===undefined&&validChatPhase(s.taskId,s.phase)&&(s.projectId===INSTRUCTIONS_CHAT_ID?s.taskId===null&&s.phase===undefined:!!scope(s.projectId,s.taskId)),subscribe:(s,event)=>chat.subscribe(s.projectId,s.taskId,event,chatPhase(s.taskId,s.phase))},
  documents:{validate:s=>s.phase===undefined&&s.terminalId===undefined&&s.taskId!==null&&!!scope(s.projectId,s.taskId),subscribe:(s,event)=>{
   const k=JSON.stringify([s.projectId,s.taskId]), listeners=documentListeners.get(k)??new Set();
   documentListeners.set(k,listeners);listeners.add(event);
   return ()=>{listeners.delete(event);if(!listeners.size)documentListeners.delete(k)};
  }},
 });
 const handle=createHandler(store,initialFolder,chat,publicOrigin,terminals,notifyTaskEvents,notifyDocuments);
 return {maxRequestBodySize:maxManualToolBodyBytes,websocket,fetch(request:Request,server:Server<SocketData>){const url=new URL(request.url);if(url.pathname!=='/api/ws')return handle(request);if(request.method!=='GET'||!access(request).allowed||!access(request).sameOrigin||request.headers.get('sec-fetch-site')==='cross-site')return new Response('Forbidden',{status:403});if(!server.upgrade(request,{data:{ready:false,used:new Set(),subscriptions:new Map()}}))return new Response('WebSocket upgrade required',{status:400});return undefined}};
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
 const chat = new ChatService(projectResolver(store),createAgents());
 const terminals = new TerminalService();
 const port = Number(process.env.BENI_PORT ?? 3210);
 const publicOrigin = process.env.BENI_PUBLIC_ORIGIN;
 const server = Bun.serve({hostname:'127.0.0.1',port,...createServerOptions(store,homedir(),chat,publicOrigin,terminals)});
 let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;await terminals.dispose();await server.stop(true);store.close();process.exit(0)};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 console.log(`Beni: http://127.0.0.1:${server.port}/`);
}
