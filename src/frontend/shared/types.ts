import type { ChatCommand } from '../../shared/chat-commands';
import type { ContextUsage, RateLimitUsage } from '../../shared/agent';
import type { Provider } from '../../shared/communication';
export type { UsageWindow } from '../../shared/agent';
export type { Provider } from '../../shared/communication';

export interface Project { id: string; name: string; folder: string; storageError?: string; folderAvailable?: false }
export interface Task { createdAt?: string | null; updatedAt?: string | null; id: string; projectId: string; name: string; phase: string; status: string }
export interface DocumentProvenance {
  revision: string;
  items: { id: string; start: number; end: number }[];
}
export interface DocumentProvenanceDetail {
  reason: string;
  sources: { kind: 'document' | 'instruction' | 'message' | 'result' | 'template' | 'legacy'; id: string; revision?: string; start?: number; text: string; taskName?: string; projectName?: string }[];
}
export interface Document { path?: string; name: string; content: string; version: number; provenance?: DocumentProvenance }
export interface TaskDetail {
  task: Task;
  documents: Document[];
  canStart?: boolean;
  workflow?: {
    review?: { state: 'pending' | 'running' | 'stopped' | 'done' | 'failed'; error?: string | null } | null;
    instructionJob?: { status: 'pending' | 'succeeded' | 'failed' | 'superseded'; error?: string };
  };
}
export interface AppState { projects: Project[]; tasks: Task[] }
export type ProviderUsage = RateLimitUsage;
export interface Model { id: string; name: string; provider?: Provider }
export interface ClaudeStatus { path: string | null; version: string | null; checkedAt: string; installed: boolean; auth: 'claude' | 'apiKey' | 'other' | 'none' | 'unknown'; models: {id: string; name: string}[] | null; usage: ProviderUsage }
export interface CodexStatus { path: string | null; version: string | null; checkedAt: string; installed: boolean; auth: 'chatgpt' | 'apiKey' | 'other' | 'none' | 'unknown'; models: { id: string; name: string }[] | null; usage: ProviderUsage }
export interface ChatMessage { errorCode?: 'MODEL_UNAVAILABLE'; diagnostic?: ChatDiagnostic; id: string; sendId: string; role: 'user' | 'assistant'; content: string; provider: Provider; model: string | null; createdAt: string; updatedAt: string; status: 'pending' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown' }
export interface ChatSession { threadId: string | null; sessionId?: string | null; contextUsage?: ContextUsage }
export interface Conversation { command?: ChatCommand; sessionProvider?: Provider; selectedModel?: Model | null; threadId: string | null; sessions?: Partial<Record<string, ChatSession>>; contextUsage?: ContextUsage; id: string; projectId: string; taskId: string | null; messages: ChatMessage[] }
import type { ChatDiagnostic } from '../../shared/chat-diagnostic';
