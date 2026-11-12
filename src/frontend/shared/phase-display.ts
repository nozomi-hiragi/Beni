import { phaseLabels } from '../../shared/task-phase';
export { phaseLabels } from '../../shared/task-phase';


export const preparationPhases = ['requirements', 'documents', 'implementation'] as const;

export const phaseDocuments = [
  ...[...preparationPhases, 'retrospective' as const].map(phase => ({ phase, name: `${phase}.md`, label: phaseLabels[phase] })),
  { phase: 'finalization' as const, name: 'knowledge.md', label: 'ナレッジ' },
];
