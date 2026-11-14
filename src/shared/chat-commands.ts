import type { ChatDiagnostic } from './chat-diagnostic';

export type ChatCommandName = string;
export type ChatCommand = {id:string;name:ChatCommandName;status:'running'|'completed'|'failed'|'interrupted'|'unknown';error?:string;output?:string;diagnostic?:ChatDiagnostic};
export type ChatCommandDefinition = {name:ChatCommandName;command:string;description:string;kind:'operation'|'message';argumentHint?:string;aliases?:readonly string[]};
export const beniChatCommands:readonly ChatCommandDefinition[] = [
 {name:'clear',command:'/clear',description:'履歴を残して新しい会話',kind:'operation',aliases:['new','reset']},
];

export function findChatCommand(name:string,commands:readonly ChatCommandDefinition[]):ChatCommandDefinition|undefined {
 return commands.find(command=>command.name===name||command.aliases?.includes(name));
}

export function parseChatCommand(text:string): {name:string;args:string}|null {
 const match=text.trim().match(/^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
 return match?{name:match[1],args:match[2]?.trim()??''}:null;
}
