import type { TaskPhase } from '../../shared/task-phase';

export const phaseLabels = { requirements: '要件定義', documents: '仕様整理', implementation: '実装手順', execution: '実装中', retrospective: '反省会', finalization: '終了' } satisfies Record<TaskPhase, string>;

export const preparationPhases = ['requirements', 'documents', 'implementation'] as const;

export const phaseDocuments = [
  ...[...preparationPhases, 'retrospective' as const].map(phase => ({ phase, name: `${phase}.md`, label: phaseLabels[phase] })),
  { phase: 'finalization' as const, name: 'knowledge.md', label: 'ナレッジ' },
];
