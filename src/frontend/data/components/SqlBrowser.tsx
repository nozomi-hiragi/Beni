import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import type { DataSqlCatalog, DataSqlResult, DataSqlValue } from '../../../shared/data-browser';
import { api, ApiError } from '../../shared/api';

const schemaQuery = "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') ORDER BY name LIMIT 500";
const tableQuery = (table: string) => `SELECT * FROM "${table.replaceAll('"', '""')}" LIMIT 500`;

function SqlValue(props: { value: DataSqlValue }) {
  const value = props.value;
  if (value === null) return <span class="italic text-base-content/65">NULL</span>;
  if (value === '') return <span class="italic text-base-content/65">空文字</span>;
  if (typeof value !== 'object') return <span>{value}</span>;
  if (value.type === 'integer') return <><span>{value.value}</span> <span class="badge badge-xs">INTEGER</span></>;
  if (value.type === 'blob') return <>
    <span>X'{value.hex}'</span> <span class="badge badge-xs">BLOB · {value.bytes} bytes</span>
    <Show when={value.truncated}> <span class="text-base-content/65">一部省略</span></Show>
  </>;
  return <><span>{value.value}</span> <span class="text-base-content/65">一部省略（{value.bytes} bytes）</span></>;
}

export default function SqlBrowser(props: {
  database: string; table: string; onSelect: (database: string, table: string) => void;
}) {
  const database = createMemo(() => props.database);
  const table = createMemo(() => props.table);
  const [databases, setDatabases] = createSignal<DataSqlCatalog['databases']>([{id: 'app', name: 'アプリDB', source: ''}]);
  const [catalog, setCatalog] = createSignal<{data?: DataSqlCatalog; error?: string}>({});
  const [catalogRetry, setCatalogRetry] = createSignal(0);
  const catalogReady = createMemo(() => catalog().data?.database === database());
  const [sql, setSql] = createSignal('');
  const [result, setResult] = createSignal<{data?: DataSqlResult; error?: string; pending?: boolean}>({});
  let queryRequest: AbortController | undefined;
  onCleanup(() => queryRequest?.abort());

  createEffect(on([database, catalogRetry], ([selected]) => {
    const request = new AbortController();
    onCleanup(() => request.abort());
    setCatalog({});
    const params = new URLSearchParams({ database: selected });
    api<DataSqlCatalog>(`/api/data/sql?${params}`, undefined, request.signal).then(data => {
      if (request.signal.aborted) return;
      batch(() => {
        setDatabases(data.databases);
        setCatalog({ data });
      });
    }).catch(error => {
      if (!request.signal.aborted) setCatalog({ error: error instanceof ApiError ? error.message : 'スキーマを取得できませんでした' });
    });
  }));

  async function execute(database: string, sql: string) {
    queryRequest?.abort();
    const request = new AbortController();
    queryRequest = request;
    setResult({ pending: true });
    try {
      const data = await api<DataSqlResult>('/api/data/sql', { database, sql }, request.signal);
      if (!request.signal.aborted) setResult({ data });
    } catch (error) {
      if (!request.signal.aborted) setResult({ error: error instanceof ApiError ? error.message : 'SQLを実行できませんでした' });
    }
  }

  function rerunTable(table: string) {
    const query = tableQuery(table);
    batch(() => {
      setSql(query);
      void execute(database(), query);
    });
  }

  createEffect(on([database, table, catalogReady], ([database, table, ready], previous) => {
    queryRequest?.abort();
    setResult({});
    const query = table ? tableQuery(table) : schemaQuery;
    if (database !== previous?.[0] || table !== previous?.[1]) setSql(query);
    if (ready && sql() === query) void execute(database, query);
  }));

  const selectedTable = createMemo(() => catalog().data?.tables.find(entry => entry.name === table()));

  return <section aria-label="SQLコンソール" class="grid min-w-0 gap-2 lg:grid-cols-[14rem_minmax(0,1fr)]">
    <aside class="card min-w-0 gap-3 self-start border border-base-300 bg-base-100 p-3">
      <label class="flex min-w-0 flex-col gap-1 text-sm font-medium">
        データベース
        <select class="select select-sm w-full" onChange={event => props.onSelect(event.currentTarget.value, '')}>
          <Show when={!databases().some(entry => entry.id === database())}>
            <option value={database()} selected>{database()}</option>
          </Show>
          <For each={databases()}>{entry => <option value={entry.id} selected={entry.id === database()} title={entry.source}>{entry.name}</option>}</For>
        </select>
      </label>
      <section aria-label="テーブル・ビュー">
        <h2 class="text-sm font-semibold">テーブル・ビュー</h2>
        <Switch>
          <Match when={catalog().error}>{error => <div class="space-y-2 py-2">
            <p role="alert" class="text-sm">{error()}</p>
            <button type="button" class="btn btn-outline btn-sm" onClick={() => setCatalogRetry(value => value + 1)}>スキーマを再取得</button>
          </div>}</Match>
          <Match when={catalog().data}>{data =>
            <Show when={data().tables.length} fallback={<p class="py-2 text-sm">テーブル・ビューがありません</p>}>
              <ul class="menu max-h-56 w-full flex-nowrap overflow-auto p-0 lg:max-h-96">
                <For each={data().tables}>{entry => <li>
                  <button type="button" class="block wrap-anywhere text-left font-mono"
                    classList={{ 'menu-active': table() === entry.name }} aria-pressed={table() === entry.name}
                    onClick={() => {
                      if (table() === entry.name) rerunTable(entry.name);
                      else props.onSelect(database(), entry.name);
                    }}>{entry.name}</button>
                </li>}</For>
              </ul>
            </Show>
          }</Match>
          <Match when={true}><p role="status" class="py-2 text-sm">スキーマを読み込み中…</p></Match>
        </Switch>
      </section>
    </aside>
    <div class="card min-w-0 gap-3 border border-base-300 bg-base-100 p-3">
      <form class="space-y-2" onSubmit={event => {
        event.preventDefault();
        if (catalogReady() && sql().trim() && !result().pending) void execute(database(), sql());
      }}>
        <label class="flex flex-col gap-1 text-sm font-medium">
          SQL
          <textarea class="textarea min-h-24 w-full font-mono" rows={4} spellcheck={false}
            value={sql()} onInput={event => setSql(event.currentTarget.value)} />
        </label>
        <div class="flex items-center gap-3">
          <button type="submit" class="btn btn-primary btn-sm" disabled={!catalogReady() || !!result().pending || !sql().trim()}>実行</button>
          <span class="text-xs text-base-content/70">読み取り専用</span>
        </div>
      </form>
      <Show when={selectedTable()}>{entry => <details class="rounded-box border border-base-300 p-2">
        <summary class="cursor-pointer text-sm">スキーマ <code class="wrap-anywhere">{entry().name}</code></summary>
        <div class="mt-2 max-h-64 overflow-auto">
          <Show when={entry().sql}>{definition => <pre class="mb-2 whitespace-pre-wrap wrap-anywhere text-xs">{definition()}</pre>}</Show>
          <table class="table table-xs" aria-label="列定義">
            <thead><tr><th scope="col">名前</th><th scope="col">型</th><th scope="col">NOT NULL</th><th scope="col">主キー</th></tr></thead>
            <tbody><For each={entry().columns}>{column => <tr>
              <td class="font-mono">{column.name}</td><td class="font-mono">{column.type}</td>
              <td>{column.notnull ? '✓' : ''}</td><td>{column.pk ? '✓' : ''}</td>
            </tr>}</For></tbody>
          </table>
        </div>
      </details>}</Show>
      <section aria-label="SQLの実行結果" class="min-w-0 space-y-2">
        <Switch>
          <Match when={result().pending}><p role="status" class="text-sm">実行中…</p></Match>
          <Match when={result().error}>{error => <p role="alert" class="wrap-anywhere text-sm text-error">{error()}</p>}</Match>
          <Match when={result().data}>{data => <>
            <p role="status" class="text-sm text-base-content/70">
              {data().rows.length} 行 · {data().elapsedMs} ms
              <Show when={data().truncated}> · 一部の結果を省略</Show>
            </p>
            <div class="max-h-[60vh] overflow-auto rounded-box border border-base-300">
              <table class="table table-sm w-max min-w-full font-mono" aria-label="SQLの結果">
                <thead class="sticky top-0 z-1 bg-base-200">
                  <tr><For each={data().columns}>{column => <th scope="col" class="whitespace-pre">{column}</th>}</For></tr>
                </thead>
                <tbody>
                  <For each={data().rows}>{row => <tr>
                    <For each={row}>{value => <td class="max-w-lg min-w-16 align-top whitespace-pre-wrap wrap-anywhere"><SqlValue value={value} /></td>}</For>
                  </tr>}</For>
                </tbody>
              </table>
            </div>
          </>}</Match>
        </Switch>
      </section>
    </div>
  </section>;
}
