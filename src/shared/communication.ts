export type Scope = {projectId:number;taskId:number|null};
export type ChatState = 'pending'|'streaming'|'completed'|'failed'|'interrupted'|'unknown';
export type Pack = {packId:string;sequence:number;messageId:string;sendId:string;role:'user'|'assistant';kind:'text'|'tool';content:string;tool:{name:string;input:string;output:string}|null;model:string|null;createdAt:string;status:ChatState;state:'streaming'|'closed'};
export type PackHeader = Omit<Pack,'content'|'tool'>;
export type PackEntry = Pick<Pack,'packId'|'state'>;
export type Topic = 'chat'|'documents';
export type TopicEvents = {'chat.pack.delta':{packId:string;delta:string;header:PackHeader};'chat.pack.closed':{packId:string;header:PackHeader};'chat.changed':Record<string,never>;'documents.changed':Record<string,never>};
export type EventName = keyof TopicEvents;
export const eventTopics = {'chat.pack.delta':'chat','chat.pack.closed':'chat','chat.changed':'chat','documents.changed':'documents'} satisfies Record<EventName,Topic>;
export type TopicEvent = {[N in EventName]:{name:N;data:TopicEvents[N]}}[EventName];
export type ClientMessage = {type:'hello';version:number}|{type:'subscribe';subscriptionId:string;topic:Topic;scope:Scope}|{type:'unsubscribe';subscriptionId:string};
export type ErrorCode = 'INVALID_MESSAGE'|'UNSUPPORTED_VERSION'|'NOT_READY'|'UNKNOWN_TOPIC'|'SUBSCRIPTION_CONFLICT'|'NOT_FOUND'|'LIMIT_EXCEEDED'|'INTERNAL_ERROR';
export type ServerMessage = {type:'ready';version:1}|{type:'subscribed'|'unsubscribed';subscriptionId:string}|({type:'event';subscriptionId:string}&TopicEvent)|{type:'error';code:ErrorCode;message:string;subscriptionId?:string};
export const object = (v:unknown):v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v);
export const validId = (v:unknown):v is string => typeof v==='string'&&v.length>0&&v.length<=128;
export const validScope = (v:unknown):v is Scope => object(v)&&Number.isSafeInteger(v.projectId)&&Number(v.projectId)>0&&(v.taskId===null||(Number.isSafeInteger(v.taskId)&&Number(v.taskId)>0));
export function validEvent(v:unknown):v is TopicEvent {if(!object(v)||!object(v.data))return false;const d=v.data;return (v.name==='chat.changed'||v.name==='documents.changed')?Object.keys(d).length===0:v.name==='chat.pack.closed'?validId(d.packId)&&validHeader(d.header)&&d.packId===d.header.packId&&d.header.state==='closed':v.name==='chat.pack.delta'&&validId(d.packId)&&typeof d.delta==='string'&&validHeader(d.header)&&d.packId===d.header.packId&&d.header.state==='streaming'&&d.header.kind==='text'&&d.header.role==='assistant'}
export function validServerMessage(v:unknown):v is ServerMessage {if(!object(v))return false;if(v.type==='ready')return v.version===1;if(v.type==='subscribed'||v.type==='unsubscribed')return validId(v.subscriptionId);if(v.type==='event')return validId(v.subscriptionId)&&validEvent(v);return v.type==='error'&&['INVALID_MESSAGE','UNSUPPORTED_VERSION','NOT_READY','UNKNOWN_TOPIC','SUBSCRIPTION_CONFLICT','NOT_FOUND','LIMIT_EXCEEDED','INTERNAL_ERROR'].includes(String(v.code))&&typeof v.message==='string'&&(v.subscriptionId===undefined||validId(v.subscriptionId))}
export function validPack(v:unknown):v is Pack {if(!object(v))return false;return validId(v.packId)&&Number.isSafeInteger(v.sequence)&&Number(v.sequence)>0&&validId(v.messageId)&&validId(v.sendId)&&(v.role==='user'||v.role==='assistant')&&(v.kind==='text'||v.kind==='tool')&&typeof v.content==='string'&&(v.tool===null||(object(v.tool)&&typeof v.tool.name==='string'&&typeof v.tool.input==='string'&&typeof v.tool.output==='string'))&&(v.model===null||typeof v.model==='string')&&typeof v.createdAt==='string'&&['pending','streaming','completed','failed','interrupted','unknown'].includes(String(v.status))&&(v.state==='streaming'||v.state==='closed')}
export function packHeader(pack:Pack):PackHeader {const {content,tool,...header}=pack;return header}
export function validHeader(v:unknown):v is PackHeader {return object(v)&&validPack({...v,content:'',tool:null})}
// Lifecycle state is carried by the closed notification, not part of the payload hash.
export async function packHash(pack:Pack):Promise<string> {const bytes=new TextEncoder().encode(JSON.stringify([1,pack.packId,pack.sequence,pack.messageId,pack.sendId,pack.role,pack.kind,pack.content,pack.tool?[pack.tool.name,pack.tool.input,pack.tool.output]:null,pack.model,pack.createdAt]));const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')}
