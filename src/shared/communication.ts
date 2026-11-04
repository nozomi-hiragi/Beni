export type Scope = {projectId:number;taskId:number|null;terminalId?:string};
export type ChatState = 'pending'|'streaming'|'completed'|'failed'|'interrupted'|'unknown';
export type Pack = {packId:string;sequence:number;messageId:string;sendId:string;role:'user'|'assistant';kind:'text'|'tool';content:string;tool:{name:string;input:string;output:string}|null;model:string|null;createdAt:string;status:ChatState;state:'streaming'|'closed'};
export type PackHeader = Omit<Pack,'content'|'tool'>;
export type PackEntry = Pick<Pack,'packId'|'state'>;
export type TerminalSession = {id:string;projectId:number;requestId:string;status:'running'|'exited'|'failed';exitCode:number|null;cols:number;rows:number};
export type TerminalAction = {type:'terminal.input';generation:number;data:string}|{type:'terminal.resize';generation:number;cols:number;rows:number}|{type:'terminal.takeover';generation:number};
export type Topic = 'chat'|'documents'|'terminal';
export type TopicEvents = {'chat.pack.delta':{packId:string;delta:string;header:PackHeader};'chat.pack.closed':{packId:string;header:PackHeader};'chat.changed':Record<string,never>;'documents.changed':Record<string,never>;
 'terminal.changed':{sessions:TerminalSession[]};
 'terminal.state':{session:TerminalSession;owner:boolean;generation:number;controlToken:string|null};
 'terminal.sync.begin':{sequence:number;cols:number;rows:number};
 'terminal.sync.chunk':{data:string};'terminal.sync.end':{sequence:number};
 'terminal.output':{sequence:number;data:string};'terminal.resized':{sequence:number;cols:number;rows:number}};
export type EventName = keyof TopicEvents;
export const eventTopics = {'chat.pack.delta':'chat','chat.pack.closed':'chat','chat.changed':'chat','documents.changed':'documents','terminal.changed':'terminal','terminal.state':'terminal','terminal.sync.begin':'terminal','terminal.sync.chunk':'terminal','terminal.sync.end':'terminal','terminal.output':'terminal','terminal.resized':'terminal'} satisfies Record<EventName,Topic>;
export type TopicEvent = {[N in EventName]:{name:N;data:TopicEvents[N]}}[EventName];
export type ClientMessage = {type:'hello';version:number}|{type:'subscribe';subscriptionId:string;topic:Topic;scope:Scope}|{type:'unsubscribe';subscriptionId:string}|(TerminalAction&{subscriptionId:string});
export type ErrorCode = 'INVALID_MESSAGE'|'UNSUPPORTED_VERSION'|'NOT_READY'|'UNKNOWN_TOPIC'|'SUBSCRIPTION_CONFLICT'|'NOT_FOUND'|'LIMIT_EXCEEDED'|'INTERNAL_ERROR'|'FORBIDDEN';
export type ServerMessage = {type:'ready';version:1}|{type:'subscribed'|'unsubscribed';subscriptionId:string}|({type:'event';subscriptionId:string}&TopicEvent)|{type:'error';code:ErrorCode;message:string;subscriptionId?:string};
export const object = (v:unknown):v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v);
export const validId = (v:unknown):v is string => typeof v==='string'&&v.length>0&&v.length<=128;
export const validScope = (v:unknown):v is Scope => object(v)&&Number.isSafeInteger(v.projectId)&&Number(v.projectId)>0&&(v.taskId===null||(Number.isSafeInteger(v.taskId)&&Number(v.taskId)>0))&&(v.terminalId===undefined||(v.taskId===null&&validId(v.terminalId)));
export function validEvent(v:unknown):v is TopicEvent {if(!object(v)||!object(v.data))return false;const d=v.data;if(typeof v.name==='string'&&v.name.startsWith('terminal.'))return validTerminalEvent(v.name,d);return (v.name==='chat.changed'||v.name==='documents.changed')?Object.keys(d).length===0:v.name==='chat.pack.closed'?validId(d.packId)&&validHeader(d.header)&&d.packId===d.header.packId&&d.header.state==='closed':v.name==='chat.pack.delta'&&validId(d.packId)&&typeof d.delta==='string'&&validHeader(d.header)&&d.packId===d.header.packId&&d.header.state==='streaming'&&d.header.kind==='text'&&d.header.role==='assistant'}
export function validServerMessage(v:unknown):v is ServerMessage {if(!object(v))return false;if(v.type==='ready')return v.version===1;if(v.type==='subscribed'||v.type==='unsubscribed')return validId(v.subscriptionId);if(v.type==='event')return validId(v.subscriptionId)&&validEvent(v);return v.type==='error'&&['INVALID_MESSAGE','UNSUPPORTED_VERSION','NOT_READY','UNKNOWN_TOPIC','SUBSCRIPTION_CONFLICT','NOT_FOUND','LIMIT_EXCEEDED','INTERNAL_ERROR','FORBIDDEN'].includes(String(v.code))&&typeof v.message==='string'&&(v.subscriptionId===undefined||validId(v.subscriptionId))}
export function validPack(v:unknown):v is Pack {if(!object(v))return false;return validId(v.packId)&&Number.isSafeInteger(v.sequence)&&Number(v.sequence)>0&&validId(v.messageId)&&validId(v.sendId)&&(v.role==='user'||v.role==='assistant')&&(v.kind==='text'||v.kind==='tool')&&typeof v.content==='string'&&(v.tool===null||(object(v.tool)&&typeof v.tool.name==='string'&&typeof v.tool.input==='string'&&typeof v.tool.output==='string'))&&(v.model===null||typeof v.model==='string')&&typeof v.createdAt==='string'&&['pending','streaming','completed','failed','interrupted','unknown'].includes(String(v.status))&&(v.state==='streaming'||v.state==='closed')}
export function packHeader(pack:Pack):PackHeader {const {content,tool,...header}=pack;return header}
export function validHeader(v:unknown):v is PackHeader {return object(v)&&validPack({...v,content:'',tool:null})}
// Lifecycle state is carried by the closed notification, not part of the payload hash.
export async function packHash(pack:Pack):Promise<string> {const bytes=new TextEncoder().encode(JSON.stringify([1,pack.packId,pack.sequence,pack.messageId,pack.sendId,pack.role,pack.kind,pack.content,pack.tool?[pack.tool.name,pack.tool.input,pack.tool.output]:null,pack.model,pack.createdAt]));const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')}

const nonnegative=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
export const validTerminalSize=(cols:unknown,rows:unknown)=>Number.isInteger(cols)&&Number(cols)>=20&&Number(cols)<=240&&Number.isInteger(rows)&&Number(rows)>=5&&Number(rows)<=80;
export function validTerminalSession(v:unknown):v is TerminalSession {return object(v)&&validId(v.id)&&Number.isSafeInteger(v.projectId)&&Number(v.projectId)>0&&validId(v.requestId)&&['running','exited','failed'].includes(String(v.status))&&(v.exitCode===null||Number.isInteger(v.exitCode))&&validTerminalSize(v.cols,v.rows)}
export function validTerminalAction(v:unknown):v is TerminalAction {return object(v)&&nonnegative(v.generation)&&(v.type==='terminal.takeover'||(v.type==='terminal.input'&&typeof v.data==='string'&&v.data.length>0&&new TextEncoder().encode(v.data).length<=4096)||(v.type==='terminal.resize'&&validTerminalSize(v.cols,v.rows)))}
function validTerminalEvent(name:string,d:Record<string,unknown>):boolean {
 if(name==='terminal.changed')return Array.isArray(d.sessions)&&d.sessions.length<=64&&d.sessions.every(validTerminalSession);
 if(name==='terminal.state')return validTerminalSession(d.session)&&typeof d.owner==='boolean'&&nonnegative(d.generation)&&(d.controlToken===null||validId(d.controlToken));
 if(name==='terminal.sync.chunk')return typeof d.data==='string'&&d.data.length<=4096;
 if(!nonnegative(d.sequence))return false;
 if(name==='terminal.sync.end')return true;
 if(name==='terminal.sync.begin'||name==='terminal.resized')return validTerminalSize(d.cols,d.rows);
 return name==='terminal.output'&&typeof d.data==='string'&&d.data.length<=4096;
}
