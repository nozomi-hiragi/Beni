import type { Provider } from './communication';

export type ChatCommandName = string;
export type ChatCommand = {id:string;name:ChatCommandName;status:'running'|'completed'|'failed'|'interrupted'|'unknown';error?:string;output?:string};
export type ChatCommandDefinition = {name:ChatCommandName;command:string;description:string;kind:'operation'|'message';argumentHint?:string;aliases?:readonly string[]};
const common:readonly Provider[]=['codex','claude'];
export const chatCommands:readonly (ChatCommandDefinition & {providers:readonly Provider[]})[] = [
 {name:'clear',command:'/clear',description:'履歴を残して新しい会話',providers:common,kind:'operation',aliases:['new','reset']},
 {name:'usage',command:'/usage',description:'使用量を表示',providers:['claude'],kind:'operation',aliases:['cost','stats']},
 {name:'review',command:'/review',description:'変更をレビュー',providers:common,kind:'message',argumentHint:'[対象]'},
 {name:'recap',command:'/recap',description:'会話を要約',providers:common,kind:'message'},
 {name:'code-review',command:'/code-review',description:'コードをレビュー',providers:['claude'],kind:'message',argumentHint:'[対象]'},
 {name:'simplify',command:'/simplify',description:'コードを簡潔にする',providers:['claude'],kind:'message'},
 {name:'security-review',command:'/security-review',description:'安全性をレビュー',providers:['claude'],kind:'message'}
];
export const beniChatCommands:readonly ChatCommandDefinition[] = chatCommands.filter(command=>command.name==='clear');

export function commandsForProvider(provider:Provider|undefined):readonly ChatCommandDefinition[] {
 return chatCommands.filter(command=>provider!==undefined&&command.providers.includes(provider));
}
export function findChatCommand(name:string,provider:Provider|undefined,commands=commandsForProvider(provider)):ChatCommandDefinition|undefined {
 return commands.find(command=>command.name===name||command.aliases?.includes(name));
}

export function parseChatCommand(text:string): {name:string;args:string}|null {
 const match=text.trim().match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
 return match?{name:match[1],args:match[2]?.trim()??''}:null;
}
