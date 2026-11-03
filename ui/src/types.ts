export interface Project { id: number; name: string; folder: string }
export interface Task { id: number; projectId: number; name: string; phase: string; status: string }
export interface Message { id: number; role: string; content: string }
export interface Document { name: string; content: string; version: number }
export interface TaskDetail { task: Task; messages: Message[]; documents: Document[] }
export interface AppState { projects: Project[]; tasks: Task[] }
