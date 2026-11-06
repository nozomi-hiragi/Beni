import type { ChatCommand } from '../shared/chat-commands';

export interface Project { id: string; name: string; folder: string }
export interface Task { createdAt?: string | null; updatedAt?: string | null; id: string; projectId: string; name: string; phase: string; status: string }
export interface DocumentProvenance {
  revision: string;
  items: { id: string; start: number; end: number }[];
}
export interface DocumentProvenanceDetail {
  reason: string;
  sources: { kind: 'document' | 'instruction' | 'message' | 'result' | 'template' | 'legacy'; id: string; revision?: string; start?: number; text: string }[];
}
export interface Document { path?: string; name: string; content: string; version: number; provenance?: DocumentProvenance }
export interface TaskDetail {
  task: Task;
  documents: Document[];
  canStart?: boolean;
  workflow?: {
    review?: { state: 'pending' | 'running' | 'done' | 'failed'; remaining: number; error?: string | null } | null;
    instructionJob?: { status: 'pending' | 'succeeded' | 'failed' | 'superseded'; error?: string };
  };
}
export interface AppState { projects: Project[]; tasks: Task[] }
export type Provider = 'codex' | 'claude';
export interface Model { id: string; name: string; provider?: Provider }
export interface ClaudeStatus { path: string | null; version: string | null; checkedAt: string; installed: boolean; auth: 'claude' | 'apiKey' | 'other' | 'none' | 'unknown'; models: {id: string; name: string}[] | null; usage: 'unknown' }
export interface CodexStatus { path: string | null; version: string | null; checkedAt: string; installed: boolean; auth: 'chatgpt' | 'apiKey' | 'other' | 'none' | 'unknown'; models: { id: string; name: string }[] | null; usage: 'unknown' }
export interface ChatMessage { errorCode?: 'MODEL_UNAVAILABLE'; id: string; sendId: string; role: 'user' | 'assistant'; content: string; provider: Provider; model: string | null; createdAt: string; updatedAt: string; status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown' }
export interface Conversation { command?: ChatCommand; sessionProvider?: Provider; selectedModel?: Model | null; id: string; projectId: string; taskId: string | null; threadId: string | null; messages: ChatMessage[] }
