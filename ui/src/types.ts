export interface Project { id: number; name: string; folder: string }
export interface Task { id: number; projectId: number; name: string; phase: string; status: string }
export interface Message { id: number; role: string; content: string }
export interface Document { name: string; content: string; version: number }
export interface TaskDetail { task: Task; messages: Message[]; documents: Document[] }
export interface AppState { projects: Project[]; tasks: Task[] }
export interface Capabilities { requirements: boolean; plan: boolean; execution: boolean; review: boolean }
export interface WorkflowEvent { id: number; kind: string; payload: Record<string, any>; attempt_id?: number }
export interface Workflow { workflow: WorkflowEvent[]; requirements: WorkflowEvent[]; plan: WorkflowEvent[]; review: Array<Record<string, any>> }
