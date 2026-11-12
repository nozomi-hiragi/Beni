import { phaseLabels } from './phase-display';

export const taskCompletedInstructionKey = 'task.completed';
export const instructionLabels: Record<string, string> = {
  editor: '編集相談用プロンプト',
  common: '全共通',
  ...phaseLabels,
  [taskCompletedInstructionKey]: 'タスク完了',
};
