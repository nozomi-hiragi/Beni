export const taskPhases = ['requirements', 'documents', 'implementation-plan', 'implementation'] as const;
export type TaskPhase = typeof taskPhases[number];
export const isTaskPhase = (value: unknown): value is TaskPhase => typeof value === 'string' && taskPhases.includes(value as TaskPhase);
