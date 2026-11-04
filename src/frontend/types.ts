export interface Project { id: string; name: string; folder: string }
export interface Task { id: string; projectId: string; name: string; phase: string; status: string }
export interface Document { path?: string; name: string; content: string; version: number }
export interface TaskDetail { task: Task; documents: Document[] }
export interface AppState { projects: Project[]; tasks: Task[] }
export interface CodexStatus { path: string | null; version: string | null; checkedAt: string; installed: boolean; auth: 'chatgpt' | 'apiKey' | 'other' | 'none' | 'unknown'; models: { id: string; name: string }[] | null; usage: 'unknown' }
export interface ChatMessage { id: string; sendId: string; role: 'user' | 'assistant'; content: string; provider: 'codex'; model: string | null; createdAt: string; updatedAt: string; status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown' }
export interface Conversation { id: string; projectId: string; taskId: string | null; threadId: string | null; messages: ChatMessage[] }
