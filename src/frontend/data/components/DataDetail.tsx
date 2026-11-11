import { createSignal, createUniqueId, ErrorBoundary, For, Match, Show, Switch } from 'solid-js';
import { object } from '../../../shared/communication';
import { dataKinds, type DataDetail as Detail, type DataView, type DocumentDiff } from '../../../shared/data-browser';
import { isTaskPhase, phaseLabels } from '../../../shared/task-phase';
import MarkdownPreview from '../../shared/components/MarkdownPreview';
import TabBar from '../../shared/components/TabBar';
import { formatDataDate } from '../format-date';
import Pagination from './Pagination';
import { Expandable, JsonValue, MetadataTable, TextValue } from './StoredValues';
import { AgentContent, TaskContent, WorkflowContent } from './RecordContents';

const tabs = [
  { id: 'content', label: '内容' },
  { id: 'storage', label: '保存データ' },
];
const documentTabs = [tabs[0], { id: 'diff', label: '前の版との差分' }, tabs[1]];
const rowTabs = [
  { id: 'content', label: '列と値' },
  { id: 'storage', label: 'JSON' },
];
const detailPageSize = 20;

function DocumentContent(props: { document: NonNullable<Detail['document']> }) {
  return <Show when={props.document.items.length} fallback={<MarkdownPreview content={props.document.content} />}>
    <For each={props.document.items}>{item => {
      if (!object(item) || typeof item.text !== 'string') return <JsonValue value={item} />;
      const reason = typeof item.reason === 'string' ? item.reason : '';
      const sources: unknown[] = Array.isArray(item.sources) ? item.sources : [];
      return <section class="border-b border-base-300">
        <MarkdownPreview content={item.text} />
        <Show when={reason.trim()}>
          <section class="space-y-2 px-5 pb-4 text-sm">
            <h3 class="font-semibold">根拠</h3>
            <p class="wrap-anywhere whitespace-pre-wrap">{reason}</p>
          </section>
        </Show>
        <Show when={sources.length}>
          <section class="space-y-2 px-5 pb-4 text-sm">
            <h3 class="font-semibold">引用元</h3>
            <ul class="list-disc space-y-2 pl-5">
              <For each={sources}>{source => <li>
                <Show when={object(source) && source} fallback={<JsonValue value={source} />} keyed>
                  {reference => <>
                    <MetadataTable fields={{
                      '種類': reference.kind, '参照 ID': reference.id,
                      '版': reference.revision, '開始位置': reference.start,
                    }} />
                    <Show when={typeof reference.text === 'string' && reference.text}>
                      {quote => <blockquote class="wrap-anywhere whitespace-pre-wrap border-l-2 border-base-300 pl-3">{quote()}</blockquote>}
                    </Show>
                  </>}
                </Show>
              </li>}</For>
            </ul>
          </section>
        </Show>
      </section>;
    }}</For>
  </Show>;
}

function DocumentDiffContent(props: { diff: DocumentDiff; history: Detail['history'] }) {
  const diff = props.diff;
  return <section class="space-y-3 p-4 text-sm">
    <Show when={'previousRevision' in diff && diff.previousRevision}>
      {revision => <p>比較元の版 {formatDataDate(props.history.find(version => version.revision === revision())?.updatedAt ?? null) ?? '日時不明'}</p>}
    </Show>
    <Switch>
      <Match when={diff.state === 'initial'}><p>前の版はありません</p></Match>
      <Match when={diff.state === 'unavailable' && diff.message}>{message => <p>{message()}</p>}</Match>
      <Match when={diff.state === 'unchanged'}><p>本文に変更はありません</p></Match>
      <Match when={diff.state === 'changed' && diff.patch}>
        {patch => <pre class="overflow-auto rounded-box bg-base-200 p-3 text-xs">{patch()}</pre>}
      </Match>
    </Switch>
  </section>;
}

function ConversationContent(props: { chat: NonNullable<Detail['conversation']> }) {
  const chat = props.chat;
  const [offset, setOffset] = createSignal(0);
  return <div class="space-y-4 p-4 text-sm">
    <section class="space-y-2">
      <h3 class="text-sm font-semibold">モデル・セッション</h3>
      <p class="wrap-anywhere text-xs">選択中のモデル <code>{chat.selectedModelId ?? '未選択'}</code></p>
      <For each={Object.entries(chat.providers)}>{([providerId, provider]) =>
        <Expandable label={`${provider.name} · ${providerId}`}>
          <Show when={provider.unassignedSession}>
            {session => <><p class="text-xs font-medium">モデル未割り当てのセッション</p><JsonValue value={session()} /></>}
          </Show>
          <Show when={provider.messageData}>
            {data => <Expandable label="モデル未割り当てのメッセージ情報"><JsonValue value={data()} /></Expandable>}
          </Show>
          <For each={Object.entries(provider.models)}>{([modelId, model]) =>
            <Expandable label={`${model.name} · ${modelId}`}>
              <Show when={model.session} fallback={<p class="text-xs text-base-content/70">セッション情報なし</p>}>
                {session => <JsonValue value={session()} />}
              </Show>
              <Show when={model.messageData}>
                {data => <Expandable label="メッセージ情報"><JsonValue value={data()} /></Expandable>}
              </Show>
            </Expandable>
          }</For>
        </Expandable>
      }</For>
    </section>
    <section class="space-y-2">
      <h3 class="text-sm font-semibold">発言（{chat.messages.length} メッセージ）</h3>
      <For each={chat.messages.slice(offset(), offset() + detailPageSize)}>{message => <div class="rounded-box border border-base-300 p-3" classList={{ 'bg-base-200/50': message.role === 'user' }}>
        <p class="text-xs font-semibold text-base-content/70">{message.role === 'user' ? 'ユーザー' : 'アシスタント'}</p>
        <p class="wrap-anywhere font-mono text-xs text-base-content/70">{message.modelId ?? message.providerId ?? 'モデル不明'} · {message.status} · {formatDataDate(message.createdAt) ?? '不明'}</p>
        <Show when={message.contentOverride}>
          {content => <p class="mt-2"><TextValue text={content()} /></p>}
        </Show>
        <ol class="mt-2 space-y-2">
          <For each={message.parts}>{part => <li>
            <p class="wrap-anywhere text-xs text-base-content/70">パート {part.sequence} · {part.kind === 'text' ? '本文' : 'ツール'} · <code>{part.packId}</code> · {part.state} / {part.status}</p>
            <Show when={part.content}><div class="mt-1"><TextValue text={part.content} /></div></Show>
            <Show when={part.tool}>{tool => <Expandable label={tool().name}>
              <MetadataTable fields={tool()} />
            </Expandable>}</Show>
          </li>}</For>
        </ol>
      </div>}</For>
      <Pagination label="会話のメッセージのページ" total={chat.messages.length} offset={offset()} limit={detailPageSize} onChange={setOffset} />
    </section>
  </div>;
}

function EventContent(props: { event: NonNullable<Detail['event']> }) {
  const event = props.event;
  return <section class="space-y-3 p-4">
    <MetadataTable fields={{
      '発生日時': formatDataDate(event.at) ?? '不明',
      'イベント種類': event.type,
      '対象タスク': event.taskName || event.taskId,
      'フェーズ': isTaskPhase(event.phase) ? phaseLabels[event.phase] : event.phase,
    }} />
    <h3 class="text-sm font-semibold">イベントの詳細</h3>
    <Show when={typeof event.details === 'string'} fallback={<JsonValue value={event.details} />}>
      <pre class="max-h-96 overflow-auto wrap-anywhere whitespace-pre-wrap rounded-box bg-base-200 p-3 text-xs">{event.details as string}</pre>
    </Show>
  </section>;
}

export default function DataDetail(props: {
  record: Detail; scopeName: string; view: DataView; onSelect: (id: string, view?: DataView) => void;
  openVersionDiff: boolean; onSelectVersion: (id: string, keepVersionDiff: boolean) => void;
}) {
  const record = props.record;
  const isDb = () => props.view === 'db';
  const isEvents = () => props.view === 'events';
  const hasSpecializedContent = () => !isDb() && (record.event || record.task || record.workflow || record.agent);
  const documentDiff = () => props.view === 'files' ? record.documentDiff : undefined;
  const storageRows = () => isDb() || isEvents() ? undefined : record.storageRows;
  const fields = () => isDb() && object(record.raw) ? record.raw : record.fields;
  const savedId = record.conversation?.chatId ?? record.eventId ?? record.fields.id;
  const [tab, setTab] = createSignal(props.openVersionDiff && documentDiff() ? 'diff' : 'content');
  const panelId = createUniqueId();
  const versions = () => {
    if (props.view !== 'files' && props.view !== 'chats') return [];
    if (record.conversation) {
      return record.history.some(version => version.id === record.id) ? record.history : [
        { id: record.id, revision: record.conversation.chatId, updatedAt: record.updatedAt },
        ...record.history,
      ];
    }
    const revision = record.document?.revision ?? (typeof record.fields.revision === 'string' ? record.fields.revision : undefined);
    if (!revision) return [];
    const selected = { id: record.id, revision, updatedAt: record.updatedAt };
    return record.history.some(version => version.revision === revision)
      ? record.history.map(version => version.revision === revision ? selected : version)
      : [selected, ...record.history];
  };

  return <>
    <header class="shrink-0 space-y-2 px-4 pt-3 pb-2">
      <div class="flex flex-wrap items-center gap-2 text-xs text-base-content/70">
        <span class="wrap-anywhere" title={record.scope}>{props.scopeName}</span>
        <span aria-hidden="true">/</span>
        <span>{dataKinds[record.kind]}</span>
        <Show when={record.status}><span class="badge badge-soft badge-xs">{record.status}</span></Show>
      </div>
      <h2 class="min-w-0 wrap-anywhere text-lg font-semibold">{record.name}</h2>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Show when={typeof savedId === 'number' || typeof savedId === 'string' && savedId !== ''}>
          <dt class="text-base-content/70">識別子</dt><dd class="wrap-anywhere font-mono">{savedId}</dd>
        </Show>
        <dt class="text-base-content/70">保存元</dt><dd class="wrap-anywhere font-mono">{record.source}</dd>
        <Show when={!isEvents() && !record.task}>
          <dt class="text-base-content/70">更新日時</dt><dd>{formatDataDate(record.updatedAt) ?? '不明'}</dd>
        </Show>
        <dt class="text-base-content/70">取得日時</dt><dd><time dateTime={record.observedAt}>{formatDataDate(record.observedAt) ?? '不明'}</time></dd>
      </dl>
      <Show when={versions().length}>
        <label class="flex items-center gap-3 text-xs">
          <span class="shrink-0 text-base-content/70">版</span>
          <select class="select select-sm w-full min-w-0" onChange={event => props.onSelectVersion(event.currentTarget.value, tab() === 'diff')}>
            <For each={versions()}>{version => <option value={version.id} selected={version.id === record.id}>
              {formatDataDate(version.updatedAt) ?? '日時不明'}
            </option>}</For>
          </select>
        </label>
      </Show>
    </header>
    <div class="shrink-0 border-y border-base-300 px-2">
      <TabBar label="詳細の表示" tabs={isDb() ? rowTabs : documentDiff() ? documentTabs : tabs} activeId={tab()} onSelect={setTab} panelId={panelId} />
    </div>
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${tab()}`} class="min-h-0 flex-1 overflow-auto">
      <Switch>
        <Match when={tab() === 'content'}>
          <Show when={isEvents() && record.event}>{event => <EventContent event={event()} />}</Show>
          <Show when={!isDb() && record.task}>{task => <TaskContent task={task()} />}</Show>
          <Show when={!isDb() && record.workflow}>{workflow => <WorkflowContent workflow={workflow()} />}</Show>
          <Show when={!isDb() && record.agent}>{agent => <AgentContent agent={agent()} />}</Show>
          <Show when={!isDb() && record.document}>{document => <DocumentContent document={document()} />}</Show>
          <Show when={!isDb() && record.conversation}>{chat => <ErrorBoundary fallback={<p role="alert" class="p-4 text-sm">会話の内容を表示できませんでした</p>}>
            <ConversationContent chat={chat()} />
          </ErrorBoundary>}</Show>
          <Show when={!hasSpecializedContent() && Object.keys(fields()).length > 0}>
            <section class="space-y-2 p-4">
              <h3 class="text-sm font-semibold">保存項目</h3>
              <MetadataTable fields={fields()} databaseRow={isDb()} />
            </section>
          </Show>
          <Show when={record.related.length > 0}>
            <section class="space-y-2 border-t border-base-300 p-4">
              <h3 class="text-sm font-semibold">関連項目</h3>
              <ul class="space-y-2">
                <For each={record.related}>{target => <li>
                  <button type="button" class="link link-primary wrap-anywhere text-left text-sm" onClick={() => props.onSelect(target.id, target.view)}>
                    {target.name}
                  </button>
                </li>}</For>
              </ul>
            </section>
          </Show>
        </Match>
        <Match when={tab() === 'diff' && documentDiff()}>{diff => <DocumentDiffContent diff={diff()} history={record.history} />}</Match>
        <Match when={tab() === 'storage'}>
          <div class="space-y-3 p-4">
            <Show when={!isDb() && record.conversation || !storageRows()?.length}>
              <section class="space-y-2">
                <h3 class="text-sm font-semibold">{!isDb() && record.conversation ? '会話ファイルの JSON' : 'SQLite の行を JSON で表示'}</h3>
                <JsonValue value={record.raw} />
              </section>
            </Show>
            <For each={storageRows()}>{entry => <section class="space-y-2">
              <h3 class="wrap-anywhere text-sm font-semibold">{entry.source} · {entry.table}{entry.role === 'previousVersion' ? '（比較元の前の版）' : ''}</h3>
              <JsonValue value={entry.row} />
            </section>}</For>
            <Show when={!isDb() && !!record.document?.items.length && record.document.items}>
              {items => <section class="space-y-3">
                <h3 class="text-sm font-semibold">文書の項目（{items().length} 件）</h3>
                <For each={items()}>{(item, index) => <section class="space-y-2">
                  <h4 class="text-sm font-semibold">項目 {index() + 1}</h4>
                  <JsonValue value={item} />
                </section>}</For>
              </section>}
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  </>;
}
