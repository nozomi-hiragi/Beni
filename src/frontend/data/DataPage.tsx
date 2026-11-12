import { batch, createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { dataKinds, type DataDetail as DataDetailData, type DataList, type DataScope, type DataSummary, type DataView } from '../../shared/data-browser';
import { api, ApiError } from '../shared/api';
import TabBar from '../shared/components/TabBar';
import DataDetail from './components/DataDetail';
import Pagination from './components/Pagination';
import SqlBrowser from './components/SqlBrowser';
import { formatDataDate } from './format-date';

const pageSize = 50;
const kindOptions = Object.entries({ all: 'すべての種類', document: dataKinds.document, instruction: dataKinds.instruction });
const tabs = [
  { id: 'files', label: 'ファイル' }, { id: 'chats', label: 'チャット' },
  { id: 'tasks', label: 'タスク' },
  { id: 'events', label: 'イベント' },
  { id: 'agents', label: 'エージェント' }, { id: 'db', label: 'DB' },
] satisfies {id: DataView; label: string}[];
const hasStatusFilter = (view: DataView) => view === 'tasks' || view === 'agents';
const hasProjectFilter = (view: DataView) => view === 'tasks' || view === 'events';

function initialLocation(view: DataView) {
  return {
    view, scope: view === 'agents' ? 'app' : 'all', kind: 'all', eventType: 'all', status: 'all',
    database: '', table: '', query: '', offset: 0, id: '',
  };
}

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const view = tabs.find(tab => tab.id === params.get('view'))?.id ?? 'files';
  const filters = initialLocation(view);
  if (view === 'db') {
    const database = params.get('database');
    filters.database = database && database !== 'all' ? database : '';
    filters.table = params.get('table') ?? '';
  } else {
    if (view !== 'agents') filters.scope = params.get('scope') || 'all';
    if (hasProjectFilter(view) && filters.scope === 'app') filters.scope = 'all';
    if (view === 'events') filters.eventType = params.get('eventType') || 'all';
    if (hasStatusFilter(view)) filters.status = params.get('status') || 'all';
    const kind = params.get('kind');
    if (view === 'files' && kind && kindOptions.some(([option]) => option === kind)) filters.kind = kind;
  }
  const offset = Number(params.get('offset'));
  return {
    ...filters,
    query: view === 'db' ? '' : params.get('query') ?? '',
    offset: view !== 'db' && Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    id: params.get('id') || '',
  };
}

type Location = ReturnType<typeof readLocation>;
type RequestState<T> = { data?: T; error?: string };

export default function DataPage() {
  const [location, setLocation] = createSignal(readLocation());
  const [mobileView, setMobileView] = createSignal<'list' | 'detail'>(location().id ? 'detail' : 'list');
  const [openVersionDiff, setOpenVersionDiff] = createSignal(false);
  const [refresh, setRefresh] = createSignal(0);
  const [listState, setListState] = createSignal<RequestState<DataList>>({});
  const [detailState, setDetailState] = createSignal<RequestState<DataDetailData>>({});
  const [chatSelection, setChatSelection] = createSignal<{ location: string; ids: Set<string> }>();
  const [scopes, setScopes] = createSignal<DataScope[]>([]);
  const [facet, setFacet] = createSignal<{view: DataView; scope: string; values: string[]}>();
  const panelId = createUniqueId();
  const view = createMemo(() => location().view);
  const isDb = () => view() === 'db';
  const isChats = () => view() === 'chats';
  const isEvents = () => view() === 'events';
  const isAgents = () => view() === 'agents';
  const hasStatus = () => hasStatusFilter(view());
  const countUnit = () => isChats() ? '場所' : view() === 'files' ? 'ファイル' : '件';
  const listPath = createMemo(() => {
    const {view, scope, kind, eventType, status, query, offset} = location();
    if (view === 'db') return;
    const params = new URLSearchParams({ view, scope });
    if (view === 'files') params.set('kind', kind);
    if (view === 'events') params.set('eventType', eventType);
    if (hasStatusFilter(view)) params.set('status', status);
    params.set('query', query.trim());
    params.set('offset', String(offset));
    params.set('limit', String(pageSize));
    return `/api/data?${params}`;
  });
  const detailId = createMemo(() => location().id);
  const linkedRow = () => detailId() ? detailState().data : undefined;
  const selectedChatLocation = createMemo(() => {
    const selection = chatSelection();
    if (isChats() && selection?.ids.has(detailId())) return selection.location;
  });
  const isSelected = (record: DataSummary) => detailId() === record.id
    || (record.chatLocation !== undefined && selectedChatLocation() === record.chatLocation);
  const list = () => listState().data;
  const records = () => list()?.records ?? [];
  const scopeName = (id: string) => scopes().find(scope => scope.id === id)?.name ?? id;

  function navigate(next: Location, replace = false, keepVersionDiff = false) {
    const params = new URLSearchParams();
    if (next.view !== 'files') params.set('view', next.view);
    if (next.view === 'db') {
      if (next.database) params.set('database', next.database);
      if (next.table) params.set('table', next.table);
    } else {
      if (next.view !== 'agents' && next.scope !== 'all') params.set('scope', next.scope);
      if (next.view === 'files' && next.kind !== 'all') params.set('kind', next.kind);
      if (next.view === 'events' && next.eventType !== 'all') params.set('eventType', next.eventType);
      if (hasStatusFilter(next.view) && next.status !== 'all') params.set('status', next.status);
    }
    if (next.query) params.set('query', next.query);
    if (next.offset) params.set('offset', String(next.offset));
    if (next.id) params.set('id', next.id);
    const path = '/data' + (params.size ? `?${params}` : '');
    if (path !== window.location.pathname + window.location.search) {
      if (replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    batch(() => {
      setOpenVersionDiff(keepVersionDiff);
      setLocation(next);
      setMobileView(next.id ? 'detail' : 'list');
    });
  }

  function filter(changes: Partial<Pick<Location, 'scope' | 'kind' | 'eventType' | 'status' | 'database' | 'table' | 'query'>>) {
    navigate({ ...location(), ...changes, offset: 0, id: '' }, changes.query !== undefined);
  }

  function selectRecord(id: string, targetView = view()) {
    navigate({ ...(targetView === view() && targetView !== 'db' ? location() : initialLocation(targetView)), id });
  }

  function selectVersion(id: string, keepVersionDiff: boolean) {
    navigate({ ...location(), id }, false, keepVersionDiff);
  }

  function selectView(id: string) {
    const tab = tabs.find(tab => tab.id === id);
    if (tab && tab.id !== view()) navigate(initialLocation(tab.id));
  }

  onMount(() => {
    const onPop = () => {
      const next = readLocation();
      batch(() => {
        setOpenVersionDiff(false);
        setLocation(next);
        setMobileView(next.id ? 'detail' : 'list');
      });
    };
    window.addEventListener('popstate', onPop);
    onCleanup(() => window.removeEventListener('popstate', onPop));
  });

  createEffect(() => {
    const path = listPath();
    refresh();
    setListState({});
    if (!path) return;
    const request = new AbortController();
    onCleanup(() => request.abort());
    api<DataList>(path, undefined, request.signal).then(data => {
      if (request.signal.aborted) return;
      batch(() => {
        setScopes(data.scopes);
        if (isEvents() || hasStatus()) {
          setFacet({view: view(), scope: location().scope, values: (isEvents() ? data.eventTypes : data.statuses) ?? []});
        }
        setListState({ data });
      });
    }).catch(() => {
      if (!request.signal.aborted) setListState({ error: 'データ一覧を取得できませんでした' });
    });
  });

  createEffect(() => {
    const id = detailId();
    const dataView = view();
    refresh();
    setDetailState({});
    if (!id) return;
    const request = new AbortController();
    onCleanup(() => request.abort());
    const params = new URLSearchParams({ id, view: dataView });
    api<DataDetailData>(`/api/data/detail?${params}`, undefined, request.signal).then(data => {
      if (request.signal.aborted) return;
      batch(() => {
        setDetailState({ data });
        if (dataView === 'chats') {
          setChatSelection(data.chatLocation ? {
            location: data.chatLocation,
            ids: new Set([id, ...data.history.map(version => version.id)]),
          } : undefined);
        }
      });
    }).catch(error => {
      if (request.signal.aborted) return;
      const message = error instanceof ApiError
        ? error.status === 404 ? '対象のデータが見つかりません' : error.message
        : 'データ詳細を取得できませんでした';
      setDetailState({ error: message });
    });
  });

  const scopeOptions = createMemo(() => {
    const options = [{id: 'all', name: 'すべて'}, ...scopes().filter(scope => !hasProjectFilter(view()) || scope.id !== 'app')];
    const id = location().scope;
    if (!options.some(option => option.id === id)) options.push({id, name: id});
    return options;
  });
  const facetOptions = createMemo(() => {
    const { view, scope, eventType, status } = location();
    const options = facet();
    const values = options?.view === view && options.scope === scope ? options.values : [];
    return [...new Set(['all', ...values, view === 'events' ? eventType : status])];
  });
  const sourceLabel = () => hasProjectFilter(view()) ? 'プロジェクト' : '所属';
  const sourceId = () => location().scope;
  const selectSource = (id: string) => {
    if (id !== sourceId()) filter({ scope: id, eventType: 'all', status: 'all' });
  };
  const searchLabel = () => {
    switch (view()) {
      case 'events': return '種類・タスク名・IDで検索';
      default: return '名前・IDで検索';
    }
  };

  return <section aria-label="データの閲覧" class="mx-auto flex h-full w-full max-w-screen-2xl flex-col gap-2">
    <div class="shrink-0 border-b border-base-300 px-2">
      <TabBar label="データの表示" tabs={tabs} activeId={view()} onSelect={selectView} panelId={panelId} />
    </div>
    <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${view()}`} class="flex min-h-0 flex-1 flex-col gap-2">
      <Show when={isDb()} fallback={<>
      <div class="flex items-center justify-between gap-2 px-2 py-1">
        <p class="text-xs text-base-content/70">
          <Show when={list()?.observedAt}>{observedAt => <>一覧の取得日時 <time dateTime={observedAt()}>{formatDataDate(observedAt()) ?? '不明'}</time></>}</Show>
        </p>
        <button type="button" class="btn btn-outline btn-sm shrink-0" onClick={() => batch(() => { setOpenVersionDiff(false); setRefresh(value => value + 1); })}>更新</button>
      </div>
      <div class="flex flex-wrap items-end justify-end gap-2 lg:hidden">
        <Show when={!isAgents()}><label class="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium">
          {sourceLabel()}
          <select class="select select-sm w-full" onChange={event => selectSource(event.currentTarget.value)}>
            <For each={scopeOptions()}>{option => <option value={option.id} selected={sourceId() === option.id}>{option.name}</option>}</For>
          </select>
        </label></Show>
        <div class="inline-flex items-stretch" role="group" aria-label="表示切り替え">
          <button type="button" class="btn btn-sm rounded-e-none hover:z-1 focus:z-2" classList={{ 'btn-active': mobileView() === 'list' }} aria-pressed={mobileView() === 'list'} onClick={() => setMobileView('list')}>一覧</button>
          <button type="button" class="btn btn-sm rounded-s-none enabled:ms-[calc(-1*var(--border,1px))] disabled:border-e-0 hover:z-1 focus:z-2" classList={{ 'btn-active': mobileView() === 'detail' }} aria-pressed={mobileView() === 'detail'} disabled={!detailId()} onClick={() => setMobileView('detail')}>詳細</button>
        </div>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2" classList={{
        'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]': isAgents(),
        'lg:grid-cols-[11rem_minmax(0,0.9fr)_minmax(0,1.1fr)]': !isAgents(),
      }}>
        <Show when={!isAgents()}><aside aria-labelledby="data-scopes" class="card hidden min-h-0 overflow-auto border border-base-300 bg-base-100 lg:block">
          <h2 id="data-scopes" class="border-b border-base-300 px-4 py-3 text-sm font-semibold">{sourceLabel()}</h2>
          <ul class="menu w-full p-2">
            <For each={scopeOptions()}>{option => <li>
              <button type="button" class="wrap-anywhere" title={option.id} classList={{ 'menu-active': sourceId() === option.id }} aria-pressed={sourceId() === option.id} onClick={() => selectSource(option.id)}>{option.name}</button>
            </li>}</For>
          </ul>
        </aside></Show>
        <section aria-labelledby="data-list" class="card min-h-0 min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100" classList={{ flex: mobileView() === 'list', 'hidden lg:flex': mobileView() === 'detail' }}>
          <div class="flex flex-wrap items-baseline justify-between gap-1 px-4 pt-3">
            <h2 id="data-list" class="text-sm font-semibold">データ一覧</h2>
            <p class="text-xs text-base-content/65" aria-live="polite">
              <Show when={list()}>{data => <>{data().total} {countUnit()}</>}</Show>
            </p>
          </div>
          <div class="grid gap-2 p-3" classList={{ 'grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]': !isChats() }}>
            <input type="search" maxLength={512} class="input input-sm w-full min-w-0" aria-label={searchLabel()} placeholder={searchLabel()} value={location().query} onInput={event => filter({ query: event.currentTarget.value })} />
            <Show when={view() === 'files'}>
              <select class="select select-sm w-full min-w-0" aria-label="種類" value={location().kind} onChange={event => filter({ kind: event.currentTarget.value })}>
                <For each={kindOptions}>{([value, label]) => <option value={value}>{label}</option>}</For>
              </select>
            </Show>
            <Show when={isEvents()}>
              <select class="select select-sm w-full min-w-0" aria-label="イベント種類" onChange={event => filter({ eventType: event.currentTarget.value })}>
                <For each={facetOptions()}>{type => <option value={type} selected={location().eventType === type}>{type === 'all' ? 'すべての種類' : type}</option>}</For>
              </select>
            </Show>
            <Show when={hasStatus()}>
              <select class="select select-sm w-full min-w-0" aria-label={isAgents() ? '利用可否' : '状態'} onChange={event => filter({ status: event.currentTarget.value })}>
                <For each={facetOptions()}>{status => <option value={status} selected={location().status === status}>{status === 'all' ? 'すべての状態' : status}</option>}</For>
              </select>
            </Show>
          </div>
          <div class="grid grid-cols-[minmax(0,1fr)_6rem] gap-2 border-y border-base-300 bg-base-200/60 px-4 py-2 text-xs text-base-content/70" aria-hidden="true">
            <span>{isChats() ? '名前・版数' : isEvents() ? '種類・日時・対象タスク' : hasStatus() ? '名前・日時' : '名前・種類'}</span>
            <span>{isEvents() ? 'プロジェクト・ID' : '所属・状態'}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <Show when={listState().error} fallback={
              <Show when={list()} fallback={<p role="status" class="px-4 py-6 text-sm">一覧を読み込み中…</p>}>
                {data => <>
                  <Show when={data().errors.length}>
                    <details class="m-3 rounded-box bg-warning/10 p-3 text-sm">
                      <summary class="cursor-pointer">取得できなかった保存元（{data().errors.length} 件）</summary>
                      <ul class="mt-2 list-disc space-y-1 ps-4">
                        <For each={data().errors}>{error => <li class="wrap-anywhere"><code>{error.source}</code> {error.message}</li>}</For>
                      </ul>
                    </details>
                  </Show>
                  <Show when={records().length} fallback={<p class="px-4 py-6 text-sm text-base-content/65">
                    {data().total > 0 ? 'このページにデータがありません' : data().errors.length ? '読み取れた保存元に該当するデータがありません' : '該当するデータがありません'}
                  </p>}>
                    <ul class="divide-y divide-base-300">
                      <For each={records()}>{record => <li>
                        <button type="button" class="grid w-full grid-cols-[minmax(0,1fr)_6rem] gap-2 border-s-2 border-transparent py-2 ps-[calc(1rem-2px)] pe-4 text-left hover:bg-base-200/65 focus-visible:-outline-offset-2"
                          classList={{ 'border-s-primary bg-primary/10': isSelected(record) }}
                          aria-pressed={isSelected(record)}
                          onClick={() => selectRecord(record.id)}>
                          <span class="flex min-w-0 flex-col gap-0.5">
                            <span class="wrap-anywhere text-sm font-medium">{record.name}</span>
                            <Show when={isEvents()} fallback={<span class="wrap-anywhere text-xs text-base-content/70">
                              {isChats() ? `${record.chatVersionCount ?? 1} 版` : hasStatus() ? record.subtitle : dataKinds[record.kind]}
                            </span>}>
                              <span class="text-xs text-base-content/70">{formatDataDate(record.updatedAt) ?? '不明'}</span>
                              <Show when={record.eventTask || record.eventPhase}>
                                <span class="wrap-anywhere text-xs text-base-content/70">{[record.eventTask, record.eventPhase].filter(Boolean).join(' · ')}</span>
                              </Show>
                            </Show>
                            <Show when={isChats() && record.subtitle}>
                              {subtitle => <span class="wrap-anywhere text-xs text-base-content/70">{subtitle()}</span>}
                            </Show>
                            <Show when={hasStatus()}>
                              <span class="text-xs text-base-content/70">
                                {view() === 'tasks' ? '更新 ' : ''}{formatDataDate(record.updatedAt) ?? '日時不明'}
                              </span>
                            </Show>
                          </span>
                          <span class="flex min-w-0 flex-col items-start gap-0.5">
                            <span class="wrap-anywhere text-xs" title={record.scope}>{scopeName(record.scope)}</span>
                            <Show when={isEvents()} fallback={
                              <Show when={record.status}><span class="badge badge-soft badge-xs h-auto max-w-full wrap-anywhere whitespace-normal">{record.status}</span></Show>
                            }>
                              <Show when={record.eventId != null}><span class="wrap-anywhere font-mono text-xs text-base-content/70">#{record.eventId}</span></Show>
                            </Show>
                          </span>
                        </button>
                      </li>}</For>
                    </ul>
                  </Show>
                </>}
              </Show>
            }>{error => <p role="alert" class="px-4 py-6 text-sm">{error()}</p>}</Show>
          </div>
          <Show when={list()}>{data => <Pagination label="データ一覧のページ" total={data().total} offset={data().offset} limit={data().limit} unit={countUnit()}
            onChange={offset => navigate({ ...location(), offset, id: '' })} />}</Show>
        </section>
        <section aria-label="データ詳細" class="card min-h-0 min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100" classList={{ flex: mobileView() === 'detail', 'hidden lg:flex': mobileView() === 'list' }}>
          <Show when={detailId()} fallback={<p class="px-4 py-6 text-sm text-base-content/65">一覧からデータを選択してください</p>}>
            <Show when={detailState().error} fallback={
              <Show when={detailState().data} keyed fallback={<p role="status" class="px-4 py-6 text-sm">詳細を読み込み中…</p>}>
                {record => <DataDetail record={record} scopeName={scopeName(record.scope)} view={view()} onSelect={selectRecord}
                  openVersionDiff={openVersionDiff()} onSelectVersion={selectVersion} />}
              </Show>
            }>{error => <p role="alert" class="px-4 py-6 text-sm">{error()}</p>}</Show>
          </Show>
        </section>
      </div>
      </>}>
        <div class="min-h-0 flex-1 space-y-2 overflow-auto p-2">
          <Show when={detailId()}>
            <Show when={detailState().error} fallback={
              <Show when={detailState().data} keyed fallback={<p role="status" class="p-3 text-sm">詳細を読み込み中…</p>}>
                {record => <section aria-label="リンク先のDB行" class="card flex max-h-96 min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100">
                  <DataDetail record={record} scopeName={scopeName(record.scope)} view="db" onSelect={selectRecord}
                    openVersionDiff={false} onSelectVersion={selectVersion} />
                </section>}
              </Show>
            }>{error => <p role="alert" class="p-3 text-sm">{error()}</p>}</Show>
          </Show>
          <Show when={!detailId() || detailState().data || detailState().error}>
            <SqlBrowser database={linkedRow()?.database || location().database || 'app'}
              table={linkedRow()?.table ?? location().table}
              onSelect={(database, table) => filter({ database, table })} />
          </Show>
        </div>
      </Show>
    </div>
  </section>;
}
