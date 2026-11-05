import type { Provider } from './communication';

export type ChatCommandName = 'compact'|'clear'|'context'|'usage'|'help'|'status'|'model'|'copy'|'export'|'rename'|'review'|'code-review'|'simplify'|'security-review'|'recap';
export type ChatCommand = {id:string;name:ChatCommandName;status:'running'|'completed'|'failed'|'interrupted'|'unknown';error?:string;output?:string};
export type ChatCommandDefinition = {name:ChatCommandName;command:string;description:string;providers:readonly Provider[];kind:'operation'|'message'|'client';argumentHint?:string;aliases?:readonly string[]};
const common:readonly Provider[]=['codex','claude'];
export const chatCommands:readonly ChatCommandDefinition[] = [
 {name:'compact',command:'/compact',description:'会話を圧縮',providers:common,kind:'operation'},
 {name:'clear',command:'/clear',description:'履歴を残して新しい会話',providers:common,kind:'operation',aliases:['new','reset']},
 {name:'context',command:'/context',description:'コンテキストの使用状況',providers:['claude'],kind:'operation'},
 {name:'usage',command:'/usage',description:'使用量を表示',providers:['claude'],kind:'operation',aliases:['cost','stats']},
 {name:'help',command:'/help',description:'コマンドの使い方',providers:common,kind:'client'},
 {name:'status',command:'/status',description:'接続と会話の状態',providers:common,kind:'client'},
 {name:'model',command:'/model',description:'モデルを選択',providers:common,kind:'client',argumentHint:'[接続先/モデルID]'},
 {name:'copy',command:'/copy',description:'最後の回答をコピー',providers:common,kind:'client'},
 {name:'export',command:'/export',description:'会話を書き出す',providers:common,kind:'client'},
 {name:'rename',command:'/rename',description:'名前を変更',providers:common,kind:'client',argumentHint:'<名前>'},
 {name:'review',command:'/review',description:'変更をレビュー',providers:common,kind:'message',argumentHint:'[対象]'},
 {name:'recap',command:'/recap',description:'会話を要約',providers:common,kind:'message'},
 {name:'code-review',command:'/code-review',description:'コードをレビュー',providers:['claude'],kind:'message',argumentHint:'[対象]'},
 {name:'simplify',command:'/simplify',description:'コードを簡潔にする',providers:['claude'],kind:'message'},
 {name:'security-review',command:'/security-review',description:'安全性をレビュー',providers:['claude'],kind:'message'}
];
export function commandsForProvider(provider:Provider|undefined):readonly ChatCommandDefinition[] {
 return chatCommands.filter(command=>provider===undefined?command.kind==='client':command.providers.includes(provider));
}
export function findChatCommand(name:string,provider:Provider|undefined):ChatCommandDefinition|undefined {
 return commandsForProvider(provider).find(command=>command.name===name||command.aliases?.includes(name));
}

export function parseChatCommand(text:string): {name:string;args:string}|null {
 const match=text.trim().match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
 return match?{name:match[1],args:match[2]?.trim()??''}:null;
}
