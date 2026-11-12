import { For, Show } from 'solid-js';
import { object } from '../../../shared/communication';
import type { DataDetail } from '../../../shared/data-browser';
import { isTaskPhase, phaseLabels } from '../../../shared/task-phase';
import { formatDataDate } from '../format-date';
import { JsonValue, MetadataTable } from './StoredValues';

function PlainText(props: {text: string}) {
  return <pre class="max-h-96 overflow-auto wrap-anywhere whitespace-pre-wrap rounded-box bg-base-200 p-3 text-xs">{props.text}</pre>;
}

function StructuredValue(props: {value: unknown; empty: string}) {
  return <Show when={props.value != null} fallback={<p class="text-sm text-base-content/70">{props.empty}</p>}>
    <Show when={typeof props.value === 'string'} fallback={<JsonValue value={props.value} />}>
      <PlainText text={props.value as string} />
    </Show>
  </Show>;
}

function Issues(props: {issues: string[]}) {
  return <Show when={props.issues.length > 0}>
    <ul class="list-disc space-y-1 rounded-box bg-warning/10 py-3 ps-8 pe-3 text-sm">
      <For each={props.issues}>{issue => <li class="wrap-anywhere">{issue}</li>}</For>
    </ul>
  </Show>;
}

export function TaskContent(props: {task: NonNullable<DataDetail['task']>}) {
  const task = props.task;
  return <section class="space-y-3 p-4">
    <MetadataTable fields={{
      'フェーズ': isTaskPhase(task.phase) ? phaseLabels[task.phase] : task.phase,
      '状態': task.status,
      '作成日時': formatDataDate(task.createdAt) ?? '不明',
      '更新日時': formatDataDate(task.updatedAt) ?? '不明',
      '最終完了日時': formatDataDate(task.completedAt) ?? '不明',
    }} />
    <h3 class="text-sm font-semibold">完了処理待ちの情報</h3>
    <StructuredValue value={task.completion} empty="なし" />
    <h3 class="text-sm font-semibold">文書基準値</h3>
    <StructuredValue value={task.baseline} empty="未記録" />
  </section>;
}

export function WorkflowContent(props: {workflow: NonNullable<DataDetail['workflow']>}) {
  const workflow = props.workflow;
  return <section class="space-y-3 border-b border-base-300 p-4">
    <h3 class="text-sm font-semibold">ワークフローの実行情報</h3>
    <MetadataTable fields={{
      'イベント名': workflow.eventKey,
      '対象タスク': workflow.taskName || workflow.taskId,
      'タスクID': workflow.taskName ? workflow.taskId : undefined,
      '状態': workflow.status,
      '実行日時': '不明',
      'エージェント': workflow.provider,
      'モデル': workflow.model,
      '入力文書の版': workflow.revision,
      '実行インストラクションの版': workflow.instructionRevision,
    }} />
    <h3 class="text-sm font-semibold">結果の理由</h3>
    <StructuredValue value={workflow.reason} empty="未記録" />
    <h3 class="text-sm font-semibold">失敗理由</h3>
    <StructuredValue value={workflow.error} empty="未記録" />
  </section>;
}

function savedModel(value: unknown): value is {id: string; name: string} {
  return object(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function usageWindow(value: unknown): value is {label: string; usedPercent?: number; resetsAt?: number; status?: string} {
  return object(value) && typeof value.label === 'string' &&
    (value.usedPercent === undefined || typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent)) &&
    (value.resetsAt === undefined || typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)) &&
    (value.status === undefined || typeof value.status === 'string');
}

function SavedUsage(props: {usage: unknown}) {
  const usage = props.usage;
  if (usage == null || usage === 'unknown') return <p class="text-sm text-base-content/70">未取得</p>;
  if (!object(usage) || typeof usage.observedAt !== 'string' || !Array.isArray(usage.windows) || !usage.windows.every(usageWindow)) {
    return <StructuredValue value={usage} empty="未取得" />;
  }
  return <>
    <p class="text-sm">利用枠の取得日時 {formatDataDate(usage.observedAt) ?? '不明'}</p>
    <For each={usage.windows} fallback={<p class="text-sm text-base-content/70">保存済みウィンドウなし</p>}>{window => <section class="rounded-box border border-base-300 p-2">
      <h4 class="wrap-anywhere px-2 text-sm font-semibold">{window.label}</h4>
      <MetadataTable fields={{
        '使用率': window.usedPercent === undefined ? '未取得' : `${window.usedPercent}%`,
        'リセット日時': formatDataDate(window.resetsAt === undefined ? null : new Date(window.resetsAt * 1000).toJSON()) ?? '不明',
        '状態': window.status,
      }} />
    </section>}</For>
  </>;
}

export function AgentContent(props: {agent: NonNullable<DataDetail['agent']>}) {
  const agent = props.agent;
  const models = Array.isArray(agent.models) && agent.models.every(savedModel) ? agent.models : null;
  return <section class="space-y-3 p-4">
    <MetadataTable fields={{
      '利用可否': agent.availability ?? '未取得',
      '認証方式': agent.auth ?? '未取得',
      'バージョン': agent.version ?? '未取得',
      '接続情報の取得日時': formatDataDate(agent.checkedAt) ?? '不明',
      '接続情報のキャッシュ': agent.invalidated ? '失効済み' : agent.checkedAt ? '保存済み' : '未取得',
    }} />
    <Issues issues={agent.issues} />
    <h3 class="text-sm font-semibold">保存済みモデル</h3>
    <Show when={models} keyed fallback={<StructuredValue value={agent.models} empty="未取得" />}>
      {entries => <ul class="list-disc space-y-1 ps-5 text-sm">
        <For each={entries} fallback={<li>保存済みモデルなし</li>}>{model => <li class="wrap-anywhere">{model.name} · <code>{model.id}</code></li>}</For>
      </ul>}
    </Show>
    <h3 class="text-sm font-semibold">保存済み利用枠</h3>
    <SavedUsage usage={agent.usage} />
  </section>;
}
