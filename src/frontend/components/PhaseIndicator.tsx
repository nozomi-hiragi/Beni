import { For, Show } from 'solid-js';

export const phaseDocuments = [
  { phase: 'requirements', name: 'requirements.md', label: '要件定義' },
  { phase: 'documents', name: 'documents.md', label: '仕様整理' },
  { phase: 'implementation-plan', name: 'implementation-plan.md', label: '実装手順' },
];

export default function PhaseIndicator(props: { phase: string; onDocument: (name: string) => void; onChange: (direction: 'back' | 'next') => void; advancing?: boolean }) {
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <For each={phaseDocuments}>{item => <>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": props.phase === item.phase}} aria-current={props.phase === item.phase ? 'step' : undefined} onClick={() => props.onDocument(item.name)}>{item.label}</button>
      <span aria-hidden="true">›</span>
    </>}</For>
    <span class="inline-flex h-8 items-center rounded px-3 text-sm text-base-content" classList={{"bg-base-300 font-semibold": props.phase === 'implementation'}} aria-current={props.phase === 'implementation' ? 'step' : undefined}>実装中</span>
    <span class="flex-1" />
    <Show when={['documents', 'implementation-plan', 'implementation'].includes(props.phase)}><button type="button" class="btn btn-sm" disabled={props.advancing} onClick={() => props.onChange('back')}>戻る</button></Show>
    <Show when={phaseDocuments.some(item => item.phase === props.phase)}><button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || !phaseDocuments.some(item => item.phase === props.phase)} onClick={() => props.onChange('next')}>{props.phase === 'implementation-plan' ? '実行指示' : '確定'}</button></Show>
  </div>;
}
