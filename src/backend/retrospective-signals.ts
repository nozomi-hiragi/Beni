import { resolve } from 'node:path';
import type { DocumentVersion } from './document-table';
import { withDatabase, type ProjectEventDetails } from './project-events';
import type { Store } from './store';

const pageSize = 8;
const evidenceLimit = 3;
const editTools = new Set(['fileChange', 'apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function excerpt(text: string, limit: number) {
  return text.slice(0, limit).replace(/[\ud800-\udbff]$/, '');
}

function summarizeDocument(document: DocumentVersion) {
  const byKind = { document: 0, instruction: 0, message: 0, result: 0 };
  const imported = { template: 0, legacy: 0 };
  const originals = new Set<string>();
  const citedItems: { item: number; excerpt: string; citations: number }[] = [];
  let items = 0;
  let citations = 0;
  for (const [index, item] of document.items.entries()) {
    const text = item.text.trim();
    if (!text) continue;
    items++;
    let count = 0;
    for (const { kind, id, revision } of item.sources) {
      if (kind === 'template' || kind === 'legacy') {
        imported[kind]++;
        continue;
      }
      byKind[kind]++;
      originals.add(JSON.stringify([kind, id, revision]));
      count++;
    }
    if (count) {
      citations += count;
      citedItems.push({ item: index, excerpt: excerpt(text, 120), citations: count });
    }
  }
  return {
    name: document.name, revision: document.revision, items, citations, byKind,
    uniqueSources: originals.size, imported,
    mostCitedItems: citedItems.sort((a, b) => b.citations - a.citations).slice(0, evidenceLimit),
  };
}

type ToolRow = { id: number; type: string; operation_id: string | null; details: string };
type CompletionRow = { outcome: string; reason: string; send_id: string };
type Anomaly = {
  eventId: number; operationId: string | null; toolName?: string;
  result: 'failed' | 'interrupted' | 'unknown'; exitCode?: number; missingFinish: boolean;
};

function executionSignals(store: Store, projectId: string, taskId: string, offset: number) {
  // taskDocumentFolder は対象タスクとプロジェクトの所属を検証する。
  const folder = resolve(store.taskDocumentFolder(projectId, taskId), '../../..');
  return withDatabase(folder, db => db.transaction(() => {
    const rows = db.query<ToolRow, [string]>(`
      SELECT event.id, event.type, event.operation_id, event.details
      FROM events AS event
      WHERE event.task_id = ? AND event.phase = 'execution' AND (
        event.type = 'tool.finished' OR (
          event.type = 'tool.started' AND NOT EXISTS (
            SELECT 1 FROM events AS finish
            WHERE finish.operation_id = event.operation_id AND finish.type = 'tool.finished'
              AND finish.task_id = event.task_id AND finish.phase = event.phase
          )
        )
      )
      ORDER BY event.id DESC
    `).iterate(taskId);

    const anomalies: Anomaly[] = [];
    const edits = new Map<string, { count: number; eventIds: number[] }>();
    let toolExecutions = 0;
    let anomalyCount = 0;
    let successfulEditCallsWithPaths = 0;
    for (const row of rows) {
      toolExecutions++;
      const { toolName, result, targetPaths, exitCode } = JSON.parse(row.details) as ProjectEventDetails;
      const missingFinish = row.type === 'tool.started';
      const completed = !missingFinish && (result === 'completed' || result === 'success') && (exitCode === undefined || exitCode === 0);
      if (!completed) {
        if (anomalyCount >= offset && anomalies.length < pageSize) {
          const status = result === 'interrupted' || result === 'cancelled' ? 'interrupted'
            : result === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'unknown';
          anomalies.push({ eventId: row.id, operationId: row.operation_id, toolName, result: status, exitCode, missingFinish });
        }
        anomalyCount++;
        continue;
      }
      if (!toolName || !editTools.has(toolName) || !targetPaths?.length) continue;
      successfulEditCallsWithPaths++;
      for (const path of new Set(targetPaths)) {
        const entry = edits.get(path) ?? { count: 0, eventIds: [] };
        entry.count++;
        if (entry.eventIds.length < evidenceLimit) entry.eventIds.push(row.id);
        edits.set(path, entry);
      }
    }
    const repeated = [...edits]
      .filter(([, evidence]) => evidence.count > 1)
      .sort(([, a], [, b]) => b.count - a.count || b.eventIds[0]! - a.eventIds[0]!);
    const completionTable = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_execution_completion'").get();
    const completion = completionTable ? db.query<CompletionRow, [string]>(`
      SELECT outcome, reason, send_id FROM document_execution_completion WHERE task_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(taskId) : null;
    const reason = completion ? excerpt(completion.reason, 1024) : null;
    return {
      area: 'execution' as const,
      coverage: 'このタスクの実装フェーズで記録されたツールイベントのみ。同じパスを対象とした既知の書き込みツールの成功を数える。シェル経由や対象パスのない編集は集計対象外。複数回の編集は手戻りの候補。',
      toolExecutions, successfulEditCallsWithPaths,
      anomalyCount, anomalies,
      repeatedEditCount: repeated.length,
      repeatedEdits: repeated.slice(offset, offset + pageSize).map(([path, evidence]) => ({ path, ...evidence })),
      latestCompletion: completion ? { outcome: completion.outcome, sendId: completion.send_id, reason, reasonTruncated: reason !== completion.reason } : null,
      next: offset + pageSize < Math.max(anomalyCount, repeated.length) ? offset + pageSize : null,
    };
  })());
}

export function retrospectiveSignals(store: Store, projectId: string, taskId: string, area: 'documents' | 'execution', offset: number) {
  if (area === 'execution') return executionSignals(store, projectId, taskId, offset);
  const documents = store.managedDocuments(projectId, taskId);
  return {
    area: 'documents' as const,
    documentCount: documents.length,
    documents: documents.slice(offset, offset + pageSize).map(summarizeDocument),
    next: offset + pageSize < documents.length ? offset + pageSize : null,
  };
}
