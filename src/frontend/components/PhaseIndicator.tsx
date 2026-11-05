import { For } from 'solid-js';

export const phaseDocuments = [
  { phase: 'requirements', name: 'requirements.md', label: '要件定義' },
  { phase: 'documents', name: 'documents.md', label: '仕様整理' },
  { phase: 'implementation-plan', name: 'implementation-plan.md', label: '実装手順' },
];

export default function PhaseIndicator(props: { phase: string; onChange: (target: string) => void; advancing?: boolean; canStart?: boolean }) {
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <For each={phaseDocuments}>{item => <>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": props.phase === item.phase}} aria-current={props.phase === item.phase ? 'step' : undefined} disabled={props.advancing || props.phase === 'implementation'} onClick={() => props.onChange(item.phase)}>{item.label}</button>
      <span aria-hidden="true">›</span>
    </>}</For>
    <span class="inline-flex h-8 items-center rounded px-3 text-sm text-base-content" classList={{"bg-base-300 font-semibold": props.phase === 'implementation'}} aria-current={props.phase === 'implementation' ? 'step' : undefined}>実装中</span>
    <span class="flex-1" />
    <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || (props.phase !== 'implementation' && !props.canStart)} onClick={() => props.onChange(props.phase === 'implementation' ? 'stop' : 'start')}>{props.phase === 'implementation' ? '停止' : '開始'}</button>
  </div>;
}
