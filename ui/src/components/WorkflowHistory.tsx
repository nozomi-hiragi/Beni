import { createMemo, For, Show } from 'solid-js';
import type { WorkflowEvent, WorkflowHistory } from './WorkflowRecovery';

const labels: Record<string, string> = {
  instruction: 'ユーザーの指示',
  plan: '計画',
  approval: '承認',
  execution_requested: '実行の依頼',
  execution_result: '実行結果',
  execution_interrupted: '実行の中断',
  recovery_acknowledged: '結果の確認記録',
  review_result: '監修結果',
  review_interrupted: '監修の中断',
  feedback: '手直し指示',
};

function description(event: WorkflowEvent): string | undefined {
  const value = event.payload;
  if (event.kind === 'instruction') return typeof value.original === 'string' ? value.original : undefined;
  if (event.kind === 'feedback') return typeof value.content === 'string' ? value.content : undefined;
  if (event.kind === 'execution_result') {
    const output = value.result?.output;
    const evidence = value.result?.evidence;
    return [typeof output === 'string' ? output : '', Array.isArray(evidence) ? evidence.filter((item: unknown) => typeof item === 'string').join('\n') : ''].filter(Boolean).join('\n');
  }
  if (event.kind === 'review_result') return typeof value.decision?.feedback === 'string' ? value.decision.feedback : undefined;
  return undefined;
}

export default function WorkflowHistoryView(props: { history: WorkflowHistory | null; integrity: boolean }) {
  const records = createMemo(() => {
    const entries = props.history?.workflow;
    if (!Array.isArray(entries) || !entries.every(event => event && typeof event.kind === 'string' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload))) return undefined;
    return entries;
  });
  return <details class="mt-3 rounded-lg border border-base-300 bg-base-100 p-3 text-sm">
    <summary class="cursor-pointer font-semibold">ワークフローの保存記録</summary>
    <Show when={!props.integrity}><p class="mt-2" role="alert">履歴の整合性を確認できないため、実行・監修結果の詳細を表示していません。</p></Show>
    <Show when={records()} fallback={<p class="mt-2">履歴を取得または確認できません。</p>}>
      <ol class="mt-2 space-y-2">
        <For each={records()} fallback={<li>保存された記録はありません。</li>}>
          {event => <li class="rounded border border-base-300 p-2">
            <strong>{labels[event.kind] ?? event.kind}</strong>
            <Show when={typeof event.payload?.status === 'string'}><span> · {event.payload.status}</span></Show>
            <Show when={typeof event.payload?.attemptId === 'number'}><span> · 実行 #{event.payload.attemptId}</span></Show>
            <Show when={(props.integrity || !['execution_result', 'review_result'].includes(event.kind)) && description(event)}>{value => <p class="mt-1 whitespace-pre-wrap break-words">{value()}</p>}</Show>
          </li>}
        </For>
      </ol>
    </Show>
  </details>;
}
