export const taskPhases = ['requirements', 'documents', 'implementation', 'execution', 'retrospective', 'finalization'] as const;
export type TaskPhase = typeof taskPhases[number];
export const isTaskPhase = (value: unknown): value is TaskPhase => typeof value === 'string' && taskPhases.includes(value as TaskPhase);

export const phaseLabels = { requirements: '要件定義', documents: '仕様整理', implementation: '実装手順', execution: '実装中', retrospective: '反省会', finalization: '終了' } satisfies Record<TaskPhase, string>;
