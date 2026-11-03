import { For, Show } from 'solid-js';
import { readAttempts, type WorkflowHistory } from './WorkflowRecovery';

export default function WorkflowResults(props: { taskId: number; history: WorkflowHistory | null; integrity: boolean }) {
  const records = () => props.integrity && readAttempts(props.history, props.taskId).valid
    ? props.history?.workflow.filter(event => event.kind === 'execution_result' || event.kind === 'review_result') ?? [] : [];
  return <Show when={records().length > 0}>
    <section aria-label="保存された実行・監修結果" class="space-y-3">
      <p class="text-xs text-base-content/60">保存記録上の過去の結果（最新とは限らず、内容の真正性は未確認）。会話とは別にまとめています。</p>
      <For each={records()}>{event => {
        const review = event.kind === 'review_result', payload = event.payload;
        const base = review
          ? ({completed:'監修完了', changes_requested:'手直しが必要', failed:'監修失敗', stale:payload.reason === 'review_failed' ? '監修失敗' : '監修結果'} as Record<string,string>)[payload.status] ?? '監修結果'
          : payload.result?.outcomeUnknown ? '実行結果は未確認' : payload.status === 'succeeded' ? '実行完了' : '実行失敗';
        const status = `${base}${payload.stale ? '（旧版）' : ''}`;
        const output: unknown = review ? (payload.status === 'failed' ? undefined : payload.decision?.feedback) : payload.status === 'succeeded' ? payload.result?.output : undefined;
        const evidence: unknown = !review && payload.status === 'succeeded' ? payload.result?.evidence : undefined;
        return <article class="rounded-xl border border-base-300 bg-base-100 px-4 py-3 text-sm">
          <strong>{status} · 実行 #{payload.attemptId}</strong>
          <Show when={typeof output === 'string' && output.trim()}><p class="mt-2 whitespace-pre-wrap break-words">{output as string}</p></Show>
          <Show when={Array.isArray(evidence) && evidence.length > 0}><div class="mt-2"><span class="font-semibold">証拠</span><ul class="list-disc pl-5"><For each={evidence as string[]}>{item => <li class="break-words">{item}</li>}</For></ul></div></Show>
        </article>;
      }}</For>
    </section>
  </Show>;
}
