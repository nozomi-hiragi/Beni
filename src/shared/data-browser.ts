import type { StoredConversation } from '../backend/chat-history';

export const dataKinds = {
  registration: '登録情報', task: 'タスク', document: '文書', instruction: 'インストラクション',
  conversation: '会話', event: 'イベント', workflow: 'ジョブ・進行状態', cache: 'キャッシュ', management: '管理情報',
} as const;
export type DataView = 'files' | 'chats' | 'events' | 'tasks' | 'agents' | 'db';
export type DataKind = keyof typeof dataKinds;
export type DataSummary = {
  id: string; name: string; scope: string; kind: DataKind; status: string;
  source: string; updatedAt: string | null;
  database?: string; table?: string; rowKey?: string;
  chatLocation?: string; chatVersionCount?: number;
  eventId?: number; eventTask?: string; eventPhase?: string;
  subtitle?: string;
};
export type DataScope = {id: string; name: string};
export type DataReadError = {source: string; message: string};
export type DataList = {
  records: DataSummary[]; scopes: DataScope[]; total: number; offset: number; limit: number;
  errors: DataReadError[]; observedAt: string;
  databases?: {id: string; name: string; source: string}[];
  tables?: {database: string; name: string}[];
  eventTypes?: string[];
  statuses?: string[];
};
export type DocumentDiff =
  | {state: 'initial'}
  | {state: 'unavailable'; message: string; previousRevision?: string}
  | {state: 'unchanged'; previousRevision: string}
  | {state: 'changed'; previousRevision: string; patch: string};
export type DataDetail = DataSummary & {
  fields: Record<string, string | number | boolean | null>;
  raw: unknown;
  storageRows?: {source: string; table: string; row: unknown; role?: 'previousVersion'}[];
  document?: {content: string; revision: string; items: unknown[]};
  documentDiff?: DocumentDiff;
  conversation?: StoredConversation;
  event?: {type: string; at: string | null; taskId: string | null; taskName: string | null; phase: string | null; details: unknown};
  task?: {phase: string | null; status: string | null; createdAt: string | null; updatedAt: string | null; completedAt: string | null; completion: unknown; baseline: unknown};
  workflow?: {eventKey: string | null; taskId: string | null; taskName: string | null; status: string | null; provider: string | null; model: string | null; error: string | null; reason: string | null; revision: string | null; instructionRevision: string | null};
  agent?: {availability: string | null; auth: string | null; version: string | null; checkedAt: string | null; invalidated: boolean; models: unknown; usage: unknown; issues: string[]};
  history: {id: string; revision: string; updatedAt: string | null}[];
  related: {id: string; name: string; view?: DataView}[];
  observedAt: string;
};

export type DataSqlCatalog = {
  databases: {id: string; name: string; source: string}[];
  database: string;
  tables: {name: string; type: string; sql: string | null;
    columns: {name: string; type: string; notnull: boolean; pk: boolean}[]}[];
  observedAt: string;
};

export type DataSqlValue = null | string | number
  | {type: 'integer'; value: string}
  | {type: 'blob'; hex: string; bytes: number; truncated?: true}
  | {type: 'text'; value: string; bytes: number; truncated: true};

export type DataSqlResult = {
  columns: string[];
  rows: DataSqlValue[][];
  truncated: boolean;
  elapsedMs: number;
  observedAt: string;
};
