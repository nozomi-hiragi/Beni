import { validTaskId } from '../shared/ids';
import { workflowEventTypes } from './project-events';

export type EmbeddedTool = {type:'function';name:string;description:string;inputSchema:Record<string,unknown>};
export type EmbeddedToolResult = {contentItems:{type:'inputText';text:string}[];success:boolean};
const integer={type:'integer',minimum:0};
const id={type:'integer',minimum:1};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[]):EmbeddedTool=>({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const defaultEventKinds=[
 'document.created','document.updated','document.renamed','document.deleted',
 'phase.changed','task.created','task.renamed','task.completed','task.reopened','task.deleted',
 'execution.started','execution.finished','operation.started','operation.finished', ...workflowEventTypes
];
const eventKindPattern='^(?:(?:document|phase|task|execution|operation|tool)\\.[a-z]+|workflow\\.(?:started|completed|failed))$';
export const eventTools:EmbeddedTool[]=[
 tool('list_events','Read a summary of relevant changes. Defaults to the current task (all project tasks in General), 20 events, and document, phase, task, execution, operation, and workflow changes. Set kind to an exact event type such as tool.finished. Continue using nextCursor if hasMore is true.',{after:integer,through:integer,limit:{type:'integer',minimum:1,maximum:100,default:20},task_id:{type:'string'},kind:{type:'string',pattern:eventKindPattern}}),
 tool('get_event','Read one event in this project.',{event_id:id},['event_id']),
 tool('get_file_change','Read the recorded file change for an event.',{event_id:id},['event_id']),
 tool('get_file_version','Restore a recorded file version without changing the file.',{path:{type:'string'},change_id:id},['path','change_id']),
 tool('get_execution_output','Read a bounded excerpt of chat output referenced by a project operation; deleted chats return deleted.',{operation_id:{type:'string'}},['operation_id']),
 tool('acknowledge_events','Confirm review through an ID in the range announced to this conversation. Retrieval alone does not acknowledge.',{through:integer},['through'])
];
export class ManualToolInputError extends Error {}
export class EventToolArgumentsError extends ManualToolInputError {}
export function eventToolArguments(name:string,value:unknown):Record<string,any>{
 const spec=eventTools.find(tool=>tool.name===name);
 if(!spec||!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid embedded tool request');
 const args=value as Record<string,unknown>,properties=spec.inputSchema.properties as Record<string,any>;
 if(Object.keys(args).some(key=>!Object.hasOwn(properties,key))||(spec.inputSchema.required as string[]).some(key=>!Object.hasOwn(args,key)))throw Error('Invalid embedded tool arguments');
 for(const [key,value] of Object.entries(args)){
  const schema=properties[key];
  if(key==='limit'&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>100))throw new EventToolArgumentsError('limit は 1〜100 の整数で指定してください。省略時は 20 件です。');
  if(key==='kind'&&(typeof value!=='string'||value.length>4096||!new RegExp(eventKindPattern).test(value)))throw new EventToolArgumentsError('kind には document.updated や tool.finished のようにイベント種別を 1 つ指定してください。');
  if(schema.type==='integer'?typeof value!=='number'||!Number.isSafeInteger(value)||value<schema.minimum||(schema.maximum!==undefined&&value>schema.maximum):typeof value!=='string'||!value||value.length>4096)throw Error('Invalid embedded tool arguments');
 }
 if(args.task_id!==undefined&&!validTaskId(args.task_id as string))throw Error('Invalid task scope');
 if(typeof args.path==='string'&&(args.path.startsWith('/')||args.path.includes('\\')||args.path.split('/').some(part=>part==='..'||part==='.'||!part)))throw Error('Invalid file scope');
 return args;
}
export const toolResult=(value:unknown,success=true):EmbeddedToolResult=>({contentItems:[{type:'inputText',text:JSON.stringify(value)}],success});

export function boundedEmbeddedToolResult(value:unknown):EmbeddedToolResult {
 const result=toolResult(value);
 const text=result.contentItems[0]?.text;
 if(text===undefined||Buffer.byteLength(text,'utf8')>1048576)throw Error('Unavailable output');
 return result;
}
