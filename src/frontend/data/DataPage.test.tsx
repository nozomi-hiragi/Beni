// @vitest-environment beni-jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DataDetail, DataList, DataSqlCatalog, DataSqlResult, DataSummary } from '../../shared/data-browser';
import DataPage from './DataPage';

const observedAt = '2026-01-02T15:04:05.000Z';
const project = { id: '019a0000-0000-7000-8000-000000000001', name: '架空プロジェクト' };
const scopes = [{id: 'app', name: 'アプリ共通'}, project];
const task: DataSummary = { id: 'task+1', name: '架空タスク', kind: 'task', scope: project.id, source: 'data/projects/project.sqlite · tasks', status: 'idle', updatedAt: null, database: project.id, table: 'tasks' };
const document: DataSummary = { ...task, id: 'document/1', name: '架空文書', kind: 'document', source: 'data/projects/project.sqlite · document_heads', table: 'document_heads', status: '現行' };
const chat: DataSummary = { id: 'chat=1', name: '架空会話', kind: 'conversation', scope: project.id, source: 'data/chats/chat.json', status: '現行', updatedAt: null, chatLocation: 'example-scope', chatVersionCount: 1 };
const instruction: DataSummary = { ...document, id: 'instruction/1', name: '架空インストラクション', kind: 'instruction', scope: 'app', source: 'data/beni.sqlite · document_versions', database: 'app', table: 'document_versions' };
const list = (records: DataSummary[], options: Partial<DataList> = {}): DataList => ({
  records, scopes, total: records.length, offset: 0, limit: 50, errors: [], observedAt, ...options,
});
const detail = (record: DataSummary, options: Partial<DataDetail> = {}): DataDetail => ({
  ...record, fields: {}, raw: {}, history: [], related: [], observedAt, ...options,
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
const deferred = () => {
  let resolve!: (result: Response) => void;
  const promise = new Promise<Response>(release => { resolve = release; });
  return { promise, resolve };
};

const databases = [{id: 'app', name: 'アプリDB', source: 'data/beni.sqlite'}, {...project, source: 'data/projects/project.sqlite'}];
const sqlCatalog = (database: string, tables: DataSqlCatalog['tables'] = []): DataSqlCatalog => ({database, databases, tables, observedAt});
const sqlTable = (name: string, type = 'table'): DataSqlCatalog['tables'][number] => ({name, type, sql: null, columns: []});
const sqlResult = (options: Partial<DataSqlResult> = {}): DataSqlResult => ({
  columns: ['name', 'type'], rows: [], truncated: false, elapsedMs: 5, observedAt, ...options,
});

function stubFetch(handle: (path: string, params: URLSearchParams, init?: RequestInit) => Response | Promise<Response>) {
  const request = vi.fn(async (input: string, init?: RequestInit) => {
    const {pathname, searchParams} = new URL(input, 'http://localhost');
    if (init?.method === 'POST') {
      expect(pathname).toBe('/api/data/sql');
      expect(searchParams.size).toBe(0);
    } else {
      expect(init?.method).toBeUndefined();
      if (pathname === '/api/data/sql') expect(searchParams.has('database')).toBe(true);
    }
    return handle(pathname, searchParams, init);
  });
  vi.stubGlobal('fetch', request);
  return request;
}

function pop(url: string) {
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

beforeEach(() => pop('/data'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); pop('/'); });

it('loads summaries before fetching the selected detail and ignores a late detail response', async () => {
  const firstList = deferred();
  const firstDetail = deferred();
  const request = stubFetch((path, params) => {
    if (path === '/api/data') return firstList.promise;
    return params.get('id') === instruction.id ? firstDetail.promise : response(detail(document));
  });
  render(() => <DataPage />);
  expect(screen.getByText('一覧を読み込み中…')).toBeTruthy();
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/data?view=files&scope=all&kind=all&query=&offset=0&limit=50']);
  firstList.resolve(response(list([document, instruction])));
  const instructionRow = await screen.findByRole('button', {name: /^架空インストラクション/});
  expect(screen.getByText('2026/01/03 00:04').getAttribute('datetime')).toBe(observedAt);
  const documentRow = screen.getByRole('button', {name: /^架空文書/});
  expect(documentRow.textContent).not.toContain('document_heads');
  expect(instructionRow.textContent).not.toContain('document_versions');
  fireEvent.click(instructionRow);
  expect(screen.getByText('詳細を読み込み中…')).toBeTruthy();
  fireEvent.click(documentRow);
  expect(await screen.findByRole('heading', {name: document.name})).toBeTruthy();
  expect(screen.getByText(document.source)).toBeTruthy();
  firstDetail.resolve(response(detail(instruction)));
  await firstDetail.promise;
  await waitFor(() => expect(screen.queryByRole('heading', {name: instruction.name})).toBeNull());
  expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(new URL(location.href).searchParams.get('id')).toBe(document.id);
});

it('restores URL filters and page, discards a late list, and refreshes current results', async () => {
  const old = deferred();
  const filters: URLSearchParams[] = [];
  const nextDocument = {...document, id: 'document/2', name: '架空文書の次の項目'};
  const request = stubFetch((path, params) => {
    expect(path).toBe('/api/data');
    filters.push(params);
    if (params.get('scope') === 'all') return response(list([instruction]));
    if (params.get('kind') === 'all') return old.promise;
    if (params.get('offset') === '50') return response(list([nextDocument], {offset: 50, total: 51}));
    return response(list([document], {total: 51}));
  });
  render(() => <DataPage />);
  await screen.findByRole('button', {name: /^架空インストラクション/});
  fireEvent.change(screen.getByRole('combobox', {name: '所属'}), {target: {value: project.id}});
  expect(screen.getByText('一覧を読み込み中…')).toBeTruthy();
  expect(screen.queryByRole('button', {name: /^架空インストラクション/})).toBeNull();
  fireEvent.change(screen.getByRole('combobox', {name: '種類'}), {target: {value: 'document'}});
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: '架空 文書'}});
  await screen.findByRole('button', {name: /^架空文書/});
  old.resolve(response(list([instruction])));
  await old.promise;
  expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  expect(screen.queryByRole('button', {name: /^架空インストラクション/})).toBeNull();
  expect(screen.getByText('51 ファイル')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '次のページ'}));
  await screen.findByRole('button', {name: new RegExp(`^${nextDocument.name}`)});
  expect(Object.fromEntries(filters.at(-1)!)).toEqual({view: 'files', scope: project.id, kind: 'document', query: '架空 文書', offset: '50', limit: '50'});
  fireEvent.click(screen.getByRole('button', {name: '更新'}));
  await screen.findByRole('button', {name: new RegExp(`^${nextDocument.name}`)});
  expect(filters.at(-1)?.toString()).toBe(filters.at(-2)?.toString());
  pop(`/data?scope=${project.id}&kind=document&query=${encodeURIComponent('架空 文書')}`);
  await screen.findByRole('button', {name: /^架空文書/});
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('架空 文書');
  expect(screen.getByRole('button', {name: '前のページ'}).hasAttribute('disabled')).toBe(true);
});

it('distinguishes request failures, unreadable sources, and a genuinely empty list', async () => {
  let listCount = 0;
  stubFetch((path) => {
    if (path === '/api/data/detail') return response({error: '会話ファイルを読み取れませんでした'}, 422);
    switch (++listCount) {
      case 1: return response({error: 'offline'}, 500);
      case 2: return response(list([chat], {errors: [{source: 'data/projects/other.sqlite', message: '読み取り失敗'}]}));
      default: return response(list([]));
    }
  });
  pop('/data?view=chats');
  render(() => <DataPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('データ一覧を取得できませんでした');
  expect(screen.queryByText('該当するデータがありません')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '更新'}));
  expect(await screen.findByText('取得できなかった保存元（1 件）')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', {name: /^架空会話/}));
  expect((await screen.findByRole('alert')).textContent).toBe('会話ファイルを読み取れませんでした');
  expect(screen.getByRole('button', {name: /^架空会話/})).toBeTruthy();
  pop('/data?view=chats');
  fireEvent.click(screen.getByRole('button', {name: '更新'}));
  expect(await screen.findByText('該当するデータがありません')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reads document text and sources and opens versions and related details outside the filters', async () => {
  const newId = 'revision/new';
  const oldId = 'revision/old';
  const updatedAt = '2026-01-01T16:02:03.000Z';
  const history = [{id: newId, revision: 'new', updatedAt}, {id: oldId, revision: 'old', updatedAt: null}];
  const source = 'data/projects/project.sqlite';
  const headRow = {name:'requirements.md',revision:'new'};
  const currentItems = [
    {id:'item-1', text:'# 現行の本文', reason:'項目を置く根拠', sources:[{
      kind:'message', id:'msg-1', revision:'example-version', start:42, text:'<script>架空の引用</script>',
    }]},
    ...Array.from({length:20}, (_, index) => ({id:`item-${index + 2}`, text:'長い保存データ'.repeat(100), reason:'', sources:[]})),
  ];
  const oldItems = [{id:'old-item', text:'# 以前の本文', reason:'以前の根拠', sources:[]}];
  const versionRow = {name:'requirements.md',revision:'new',items_json:JSON.stringify(currentItems)};
  const oldRow = {name:'requirements.md',revision:'old',items_json:JSON.stringify(oldItems)};
  const requested: string[] = [];
  stubFetch((path, params, init) => {
    if (path === '/api/data/sql') return response(init?.method === 'POST' ? sqlResult() : sqlCatalog(params.get('database')!));
    if (path === '/api/data') return response(list([document]));
    const id = params.get('id')!;
    requested.push(id);
    if (id === oldId) return response(detail({...document, id: oldId, table: 'document_versions', status: '過去版'}, {
      document: {content: oldItems[0]!.text, revision: 'old', items: oldItems},
      raw: oldRow,
      documentDiff: {state:'initial'},
      history,
    }));
    if (id === task.id) {
      const fields = {id: 'saved-task-id', archived: false};
      return response(detail(task, {fields, raw: fields}));
    }
    return response(detail({ ...document, id, updatedAt, ...(id === newId && {table: 'document_versions'}) }, {
      document: {content: currentItems.map(item => item.text).join('\n\n'), revision: 'new', items: currentItems},
      raw: headRow,
      storageRows: [
        {source,table:'document_heads',row:headRow},
        {source,table:'document_versions',row:versionRow},
        {source,table:'document_versions',row:oldRow,role:'previousVersion'},
      ],
      documentDiff: {state:'changed',previousRevision:'old',patch:'--- requirements.md\n+++ requirements.md\n-# 以前の本文\n+# 現行の本文'},
      history,
      related: [{id: task.id, name: task.name, view: 'db'}],
    }));
  });
  pop('/data?kind=document&query=%E6%96%87%E6%9B%B8');
  render(() => <DataPage />);
  fireEvent.click(await screen.findByRole('button', {name: /^架空文書/}));
  const heading = await screen.findByRole('heading', {name: '現行の本文'});
  const contentPanel = screen.getByRole('tabpanel', {name: '内容'});
  expect(within(contentPanel).getAllByRole('article')).toHaveLength(21);
  expect(within(contentPanel).getAllByRole('heading', {name: '根拠'})).toHaveLength(1);
  expect(within(contentPanel).getAllByRole('heading', {name: '引用元'})).toHaveLength(1);
  const item = heading.closest('section')!;
  const reason = within(item).getByText('項目を置く根拠');
  const sources = within(item).getByRole('list');
  expect(heading.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(reason.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const value of ['message', 'msg-1', 'example-version', '42']) {
    expect(within(sources).getByText(value)).toBeTruthy();
  }
  expect(within(sources).getByText('<script>架空の引用</script>').tagName).toBe('BLOCKQUOTE');
  expect(sources.querySelector('script')).toBeNull();
  expect(within(screen.getByRole('tablist', {name: '詳細の表示'})).getAllByRole('tab').map(tab => tab.textContent))
    .toEqual(['内容', '前の版との差分', '保存データ']);
  fireEvent.click(screen.getByRole('tab', {name: '前の版との差分'}));
  const diffPanel = screen.getByRole('tabpanel', {name: '前の版との差分'});
  expect(within(diffPanel).getByText('比較元の版 日時不明')).toBeTruthy();
  expect(diffPanel.querySelector('pre')?.textContent).toContain('-# 以前の本文\n+# 現行の本文');
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  const storagePanel = () => screen.getByRole('tabpanel', {name: '保存データ'});
  const savedJson = () => Array.from(storagePanel().querySelectorAll('code'), code => JSON.parse(code.textContent!));
  expect(within(storagePanel()).getAllByRole('heading', {level:3}).map(heading => heading.textContent))
    .toEqual([`${source} · document_heads`, `${source} · document_versions`, `${source} · document_versions（比較元の前の版）`, '文書の項目（21 件）']);
  expect(within(storagePanel()).getAllByRole('heading', {level:4}).map(heading => heading.textContent))
    .toEqual(currentItems.map((_, index) => `項目 ${index + 1}`));
  expect(savedJson()).toEqual([headRow, versionRow, oldRow, ...currentItems]);
  expect(screen.queryByRole('tab', {name: '履歴'})).toBeNull();
  const metadata = screen.getByRole('region', {name: 'データ詳細'}).querySelector('dl')!;
  expect(within(metadata).getByText('2026/01/02 01:02')).toBeTruthy();
  expect(within(metadata).getByText('2026/01/03 00:04').getAttribute('datetime')).toBe(observedAt);
  const versionSelect = () => screen.getByRole<HTMLSelectElement>('combobox', {name: '版'});
  expect(versionSelect().value).toBe(document.id);
  expect(within(versionSelect()).getAllByRole('option').map(option => option.textContent?.trim()))
    .toEqual(['2026/01/02 01:02', '日時不明']);
  fireEvent.change(versionSelect(), {target: {value: oldId}});
  expect(await screen.findByRole('heading', {name: '以前の本文'})).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: '前の版との差分'}));
  expect(screen.getByText('前の版はありません')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  expect(screen.getByRole('heading', {name: 'SQLite の行を JSON で表示'})).toBeTruthy();
  expect(savedJson()).toEqual([oldRow, ...oldItems]);
  expect(new URL(location.href).searchParams.get('kind')).toBe('document');
  expect(versionSelect().value).toBe(oldId);
  fireEvent.change(versionSelect(), {target: {value: newId}});
  expect(await screen.findByRole('heading', {name: '現行の本文'})).toBeTruthy();
  expect(versionSelect().value).toBe(newId);
  const panel = screen.getByRole('tabpanel', {name: '内容'});
  fireEvent.click(within(panel).getByRole('button', {name: task.name}));
  expect(await screen.findByRole('heading', {name: task.name})).toBeTruthy();
  const header = screen.getByRole('heading', {name: task.name}).closest('header')!;
  expect(within(header).getByText('saved-task-id')).toBeTruthy();
  expect(within(header).queryByText(task.id)).toBeNull();
  expect(screen.getByText('false')).toBeTruthy();
  expect(requested).toEqual([document.id, oldId, newId, task.id]);
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'db', id: task.id});
});

it('opens SQL from the DB tab and restores the table and linked row from the URL', async () => {
  const revision: DataSummary = { ...document, id: 'revision/1', source: 'data/projects/project.sqlite · document_versions',
    table: 'document_versions', rowKey: 'saved-revision-id' };
  const content = {content: '# 文書のプレビュー', revision: 'new', items: []};
  const raw = {id: 'saved-revision-id', content: '保存済みの値', payload: {type: 'BLOB', bytes: 42}, removed_at: null};
  const request = stubFetch((path, params, init) => {
    if (path === '/api/data/detail') return response(detail(
      params.get('view') === 'db' ? revision : document,
      {document: content, raw, fields: {content: '概要'}, history: [{id: 'old', revision: 'old', updatedAt: null}]},
    ));
    if (path === '/api/data/sql') {
      if (init?.method === 'POST') return response(sqlResult());
      const database = params.get('database')!;
      return response(sqlCatalog(database, database === 'app' ? [sqlTable('projects')] : [sqlTable('document_versions')]));
    }
    expect(params.get('view')).toBe('files');
    return response(list([document]));
  });

  const fileUrl = `/data?scope=${project.id}&kind=document&query=example&offset=50&id=${encodeURIComponent(document.id)}`;
  pop(fileUrl);
  render(() => <DataPage />);
  expect(await screen.findByRole('heading', {name: '文書のプレビュー'})).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', {name: 'DB'}));
  expect(window.location.search).toBe('?view=db');
  expect(await screen.findByRole('button', {name: 'projects'})).toBeTruthy();
  expect(screen.queryByRole('combobox', {name: '種類'})).toBeNull();
  expect(screen.queryByRole('heading', {name: '文書のプレビュー'})).toBeNull();

  const dbUrl = `/data?view=db&id=${encodeURIComponent(revision.id)}`;
  pop(dbUrl);
  const linked = within(await screen.findByRole('region', {name: 'リンク先のDB行'}));
  expect(linked.getByRole('tab', {name: '列と値'})).toBeTruthy();
  expect(linked.getByText('保存済みの値')).toBeTruthy();
  expect(linked.getByText('BLOB (42 bytes)')).toBeTruthy();
  expect(linked.getByText('NULL')).toBeTruthy();
  expect(screen.queryByRole('combobox', {name: '版'})).toBeNull();
  fireEvent.click(linked.getByRole('tab', {name: 'JSON'}));
  expect(linked.getByText(/"bytes": 42/)).toBeTruthy();
  expect((await screen.findByRole('button', {name: 'document_versions'})).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole<HTMLSelectElement>('combobox', {name: 'データベース'}).value).toBe(project.id);
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'SQL'}).value).toBe('SELECT * FROM "document_versions" LIMIT 500');
  expect(request.mock.calls.some(([path]) => path === `/api/data/detail?id=${encodeURIComponent(revision.id)}&view=db`)).toBe(true);
  expect(request.mock.calls.some(([path]) => path.startsWith('/api/data?view=db'))).toBe(false);

  fireEvent.click(screen.getByRole('tab', {name: 'ファイル'}));
  expect(window.location.search).toBe('');
  pop(fileUrl);
  expect(await screen.findByRole('heading', {name: '文書のプレビュー'})).toBeTruthy();
  pop(dbUrl);
  expect(await screen.findByText('保存済みの値')).toBeTruthy();
  await screen.findByRole('option', {name: project.name});
  fireEvent.change(screen.getByRole('combobox', {name: 'データベース'}), {target: {value: 'app'}});
  expect(await screen.findByRole('button', {name: 'projects'})).toBeTruthy();
  expect(screen.queryByRole('region', {name: 'リンク先のDB行'})).toBeNull();
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'db', database: 'app'});
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'SQL'}).value).toMatch(/FROM sqlite_schema/);
});

it('runs SQL, quotes table names, displays SQLite values and keeps SQL out of the URL', async () => {
  const table = 'x"y';
  const definition = 'CREATE VIEW "x""y" AS SELECT 1 AS id';
  const requests: {database: string; sql: string}[] = [];
  const literal = '<img src="example">{"name":"example"}';
  const savedTime = '2026-01-01T00:00:00.000Z';
  const pending = deferred();
  const request = stubFetch((path, params, init) => {
    expect(path).toBe('/api/data/sql');
    if (init?.method !== 'POST') return response(sqlCatalog(params.get('database')!, [{
      ...sqlTable(table, 'view'), sql: definition, columns: [{name: 'id', type: 'INTEGER', notnull: true, pk: false}],
    }]));
    const query = JSON.parse(String(init.body));
    requests.push(query);
    if (query.sql === 'SELECT broken') return response({error: 'SQLに誤りがあります'}, 400);
    if (query.sql === 'SELECT 2') return pending.promise;
    return response(sqlResult());
  });
  pop('/data?view=db');
  render(() => <DataPage />);
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', {name: 'SQL'});
  const execute = () => screen.getByRole<HTMLButtonElement>('button', {name: '実行'});
  const run = (sql: string) => {
    fireEvent.input(editor, {target: {value: sql}});
    fireEvent.submit(execute().form!);
  };
  expect(editor.value).toMatch(/FROM sqlite_schema/);
  expect(requests).toEqual([]);
  const tableButton = await screen.findByRole('button', {name: table});
  expect(requests[0]).toEqual({database: 'app', sql: editor.value});
  fireEvent.click(tableButton);
  expect(requests.at(-1)).toEqual({database: 'app', sql: 'SELECT * FROM "x""y" LIMIT 500'});
  expect(editor.value).toBe(requests.at(-1)?.sql);
  expect(request.mock.calls.filter(([path]) => path.includes('?database='))).toHaveLength(1);
  expect(screen.getByText(definition)).toBeTruthy();
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'db', database: 'app', table});
  expect(await screen.findByText('0 行 · 5 ms')).toBeTruthy();
  run('SELECT broken');
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'SQLに誤りがあります');
  run('SELECT 2');
  expect(execute().disabled).toBe(true);
  expect(screen.getByText('実行中…')).toBeTruthy();
  pending.resolve(response(sqlResult({
    columns: ['a', 'a', 'payload', 'number', 'blob', 'text', 'date'],
    rows: [[null, '', literal, {type: 'integer', value: '9223372036854775807'},
      {type: 'blob', hex: '00ff', bytes: 4, truncated: true}, {type: 'text', value: '省略前', bytes: 70000, truncated: true}, savedTime]],
    truncated: true,
  })));
  const result = within(await screen.findByRole('table', {name: 'SQLの結果'}));
  expect(result.getAllByRole('columnheader').map(column => column.textContent)).toEqual(['a', 'a', 'payload', 'number', 'blob', 'text', 'date']);
  for (const value of ['NULL', '空文字', literal, '9223372036854775807', 'INTEGER', "X'00ff'", 'BLOB · 4 bytes', '省略前', '一部省略（70000 bytes）', savedTime]) {
    expect(result.getByText(value)).toBeTruthy();
  }
  expect(result.queryByRole('img')).toBeNull();
  expect(screen.getByText(/一部の結果を省略/)).toBeTruthy();
  expect(execute().disabled).toBe(false);
  expect(location.search).not.toContain('SELECT');
});

it('switches databases and ignores late results and catalogs', async () => {
  const oldResult = deferred();
  const oldCatalog = deferred();
  let appCatalogReads = 0;
  const request = stubFetch((path, params, init) => {
    expect(path).toBe('/api/data/sql');
    if (init?.method === 'POST') {
      const {database, sql} = JSON.parse(String(init.body));
      if (database === 'app' && sql === 'SELECT 1') return oldResult.promise;
      return response(sqlResult({columns: ['name'], rows: [[database === 'app' ? 'appの結果' : 'projectの結果']]}));
    }
    const database = params.get('database')!;
    if (database === 'app' && ++appCatalogReads > 1) return oldCatalog.promise;
    return response(sqlCatalog(database, [sqlTable(database === 'app' ? 'projects' : 'events')]));
  });
  pop('/data?view=db');
  render(() => <DataPage />);
  const databaseSelect = screen.getByRole('combobox', {name: 'データベース'});
  expect(await screen.findByText('appの結果')).toBeTruthy();
  expect(await screen.findByRole('button', {name: 'projects'})).toBeTruthy();
  fireEvent.input(screen.getByRole('textbox', {name: 'SQL'}), {target: {value: 'SELECT 1'}});
  fireEvent.submit(screen.getByRole<HTMLButtonElement>('button', {name: '実行'}).form!);
  const appQuery = request.mock.calls.at(-1)?.[1];
  fireEvent.change(databaseSelect, {target: {value: project.id}});
  expect(await screen.findByRole('button', {name: 'events'})).toBeTruthy();
  expect(await screen.findByText('projectの結果')).toBeTruthy();
  expect(appQuery?.signal?.aborted).toBe(true);
  oldResult.resolve(response(sqlResult({columns: ['old'], rows: [['古い結果']]})));
  await oldResult.promise;
  fireEvent.change(databaseSelect, {target: {value: 'app'}});
  const appCatalog = request.mock.calls.findLast(([path]) => path === '/api/data/sql?database=app')?.[1];
  expect(screen.queryByText('projectの結果')).toBeNull();
  expect(request.mock.calls.at(-1)?.[0]).toBe('/api/data/sql?database=app');
  fireEvent.change(databaseSelect, {target: {value: project.id}});
  expect(appCatalog?.signal?.aborted).toBe(true);
  oldCatalog.resolve(response(sqlCatalog('app', [sqlTable('古いテーブル')])));
  await oldCatalog.promise;
  expect(await screen.findByText('projectの結果')).toBeTruthy();
  expect(screen.queryByText('古い結果')).toBeNull();
  expect(screen.queryByRole('button', {name: '古いテーブル'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'projects'})).toBeNull();
});

it('retries a failed catalog before running the default SQL', async () => {
  let catalogReads = 0;
  const request = stubFetch((path, params, init) => {
    expect(path).toBe('/api/data/sql');
    if (init?.method === 'POST') return response(sqlResult());
    if (++catalogReads === 1) return response({error: 'スキーマの取得に失敗しました'}, 429);
    return response(sqlCatalog(params.get('database')!, [sqlTable('projects')]));
  });
  pop('/data?view=db');
  render(() => <DataPage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'スキーマの取得に失敗しました');
  expect(screen.getByRole<HTMLButtonElement>('button', {name: '実行'}).disabled).toBe(true);
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/data/sql?database=app']);
  fireEvent.click(screen.getByRole('button', {name: 'スキーマを再取得'}));
  expect(await screen.findByRole('button', {name: 'projects'})).toBeTruthy();
  expect(await screen.findByText('0 行 · 5 ms')).toBeTruthy();
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/data/sql?database=app', '/api/data/sql?database=app', '/api/data/sql']);
  expect(screen.queryByRole('button', {name: 'スキーマを再取得'})).toBeNull();
});

it('shows saved conversation providers, sessions and message parts, and reloads the selected detail', async () => {
  const conversation: NonNullable<DataDetail['conversation']> = {
    version: 3, chatId: chat.id, projectId: project.id, taskId: task.id, phase: 'requirements',
    selectedModelId: 'example/example-model',
    providers: {
      example: {name: '架空接続先', models: {'example-model': {name: '架空モデル', session: {resumeId: 'example-resume', lastEventId: 1}}}},
    },
    messages: [{
      id: 'message', sendId: 'send', role: 'assistant', modelId: 'example/example-model',
      createdAt: observedAt, updatedAt: observedAt, status: 'completed',
      parts: [{
        kind: 'tool', packId: 'part', sequence: 1, content: 'ツールの結果',
        tool: {name: '架空ツール', input: '入力値', output: '<img src="example">'},
        createdAt: observedAt, state: 'closed', status: 'completed',
      }],
    }],
  };
  let detailReads = 0;
  stubFetch((path) => path === '/api/data' ? response(list([chat])) : response(detail(chat, {
    raw: conversation, conversation, fields: {archived: ++detailReads > 1},
    storageRows: [{source:'data/beni.sqlite',table:'chat_refs',row:{chat_id:chat.id,scope_key:'example-scope'}}],
  })));
  pop(`/data?view=chats&id=${encodeURIComponent(chat.id)}`);
  render(() => <DataPage />);
  expect(await screen.findByText('ツールの結果')).toBeTruthy();
  expect(screen.getByText('example/example-model · completed · 2026/01/03 00:04')).toBeTruthy();
  const versionSelect = screen.getByRole<HTMLSelectElement>('combobox', {name: '版'});
  expect(versionSelect.value).toBe(chat.id);
  expect(within(versionSelect).getByRole('option', {name: '日時不明'})).toBeTruthy();
  const expand = (label: string | RegExp) => {
    const target = screen.getByText(label).closest('details')!;
    target.open = true;
    fireEvent(target, new Event('toggle'));
  };
  expand(/^架空接続先/);
  expand(/^架空モデル/);
  expect(screen.getByText(/"resumeId": "example-resume"/)).toBeTruthy();
  expand('架空ツール');
  expect(screen.getByText('<img src="example">')).toBeTruthy();
  expect(screen.getByRole('tabpanel', {name: '内容'}).querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  expect(screen.getByRole('heading', {name: '会話ファイルの JSON'})).toBeTruthy();
  expect(screen.getByRole('heading', {name: 'data/beni.sqlite · chat_refs'})).toBeTruthy();
  expect(screen.getByText(/"scope_key": "example-scope"/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '更新'}));
  expect(await screen.findByText('true')).toBeTruthy();
  expect(detailReads).toBe(2);
});

it('keeps the chat location selected when opening a version and restores filters and versions through history', async () => {
  const current = {...chat, chatVersionCount: 2, updatedAt: observedAt};
  const previous = {...chat, id: 'chat/old', status: 'アーカイブ', updatedAt: '2026-01-01T14:03:00Z'};
  const history = [
    {id: current.id, revision: 'current-chat', updatedAt: current.updatedAt},
    {id: previous.id, revision: 'previous-chat', updatedAt: previous.updatedAt},
  ];
  const chatDetail = (record: DataSummary, version: typeof history[number], content: string) => {
    const conversation: NonNullable<DataDetail['conversation']> = {
      version: 3, chatId: version.revision, projectId: project.id, taskId: task.id, phase: 'requirements',
      selectedModelId: null, providers: {}, messages: [{
        id: 'message', sendId: 'send', role: 'user', modelId: null, contentOverride: content,
        createdAt: observedAt, updatedAt: observedAt, status: 'completed', parts: [],
      }],
    };
    return detail(record, {
      conversation, raw: conversation, history,
      storageRows: [{source: 'data/beni.sqlite', table: 'chat_refs', row: {chat_id: version.revision}}],
    });
  };
  const previousDetail = chatDetail(previous, history[1]!, '過去の会話本文');
  const old = deferred();
  let previousReads = 0;
  const request = stubFetch((path, params, init) => {
    if (path === '/api/data/sql') return response(init?.method === 'POST' ? sqlResult() : sqlCatalog(params.get('database')!));
    if (path === '/api/data') {
      if (params.get('view') === 'chats') return response(list([current], {offset: Number(params.get('offset')), total: 51}));
      return response(list([document]));
    }
    if (params.get('id') === document.id) return response(detail(document, {
      related: [{id: current.id, name: current.name, view: 'chats'}],
    }));
    expect(params.get('view')).toBe('chats');
    if (params.get('id') === previous.id) return ++previousReads === 1 ? old.promise : response(previousDetail);
    return response(chatDetail(current, history[0]!, '現行の会話本文'));
  });
  pop(`/data?kind=document&id=${encodeURIComponent(document.id)}`);
  render(() => <DataPage />);
  const detailPanel = () => within(screen.getByRole('region', {name: 'データ詳細'}));
  const versionSelect = () => detailPanel().getByRole<HTMLSelectElement>('combobox', {name: '版'});
  fireEvent.click(await detailPanel().findByRole('button', {name: current.name}));
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'chats', id: current.id});
  expect(await screen.findByText('現行の会話本文')).toBeTruthy();
  expect(screen.queryByRole('combobox', {name: '種類'})).toBeNull();
  expect(screen.queryByRole('combobox', {name: 'テーブル'})).toBeNull();
  fireEvent.change(screen.getByRole('combobox', {name: '所属'}), {target: {value: project.id}});
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: current.name}});
  await screen.findByRole('button', {name: /^架空会話/});
  fireEvent.click(screen.getByRole('button', {name: '次のページ'}));
  const row = await screen.findByRole('button', {name: /^架空会話/});
  expect(row.textContent).toContain('2 版');
  expect(row.textContent).toContain('現行');
  expect(screen.getByText('51 場所')).toBeTruthy();
  expect(request.mock.calls.at(-1)?.[0]).toBe(`/api/data?${new URLSearchParams({view: 'chats', scope: project.id, query: current.name, offset: '50', limit: '50'})}`);
  fireEvent.click(row);
  expect(await screen.findByText('現行の会話本文')).toBeTruthy();
  expect(within(versionSelect()).getAllByRole('option').map(option => option.textContent?.trim()))
    .toEqual(['2026/01/03 00:04', '2026/01/01 23:03']);
  expect(versionSelect().value).toBe(current.id);
  fireEvent.change(versionSelect(), {target: {value: previous.id}});
  expect(row.getAttribute('aria-pressed')).toBe('true');
  old.resolve(response(previousDetail));
  expect(await screen.findByText('過去の会話本文')).toBeTruthy();
  expect(detailPanel().getByText('アーカイブ')).toBeTruthy();
  expect(detailPanel().getByText('previous-chat')).toBeTruthy();
  expect(row.getAttribute('aria-pressed')).toBe('true');
  expect(versionSelect().value).toBe(previous.id);
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({
    view: 'chats', scope: project.id, query: current.name, offset: '50', id: previous.id,
  });
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  const saved = screen.getByRole('tabpanel', {name: '保存データ'});
  expect(within(saved).getByText(/"chatId": "previous-chat"/)).toBeTruthy();
  expect(within(saved).getByText(/"chat_id": "previous-chat"/)).toBeTruthy();
  fireEvent.change(versionSelect(), {target: {value: current.id}});
  expect(await screen.findByText('現行の会話本文')).toBeTruthy();
  window.history.back();
  expect(await screen.findByText('過去の会話本文')).toBeTruthy();
  expect(row.getAttribute('aria-pressed')).toBe('true');
  window.history.forward();
  expect(await screen.findByText('現行の会話本文')).toBeTruthy();

  fireEvent.click(screen.getByRole('tab', {name: 'DB'}));
  expect(location.search).toBe('?view=db');
  expect(await screen.findByText('0 行 · 5 ms')).toBeTruthy();
  expect(screen.getByRole('textbox', {name: 'SQL'})).toBeTruthy();
  expect(screen.queryByRole('combobox', {name: '所属'})).toBeNull();
  fireEvent.click(screen.getByRole('tab', {name: 'チャット'}));
  expect(location.search).toBe('?view=chats');
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('combobox', {name: '所属'}) as HTMLSelectElement).value).toBe('all');
  fireEvent.click(screen.getByRole('tab', {name: 'ファイル'}));
  expect(location.search).toBe('');
  expect(await screen.findByText('1 ファイル')).toBeTruthy();
  expect(screen.getByRole('combobox', {name: '種類'})).toBeTruthy();
});

it('filters events by project and type, opens the saved row, and restores the event through browser history', async () => {
  const event = {
    ...task, id: 'event/42', kind: 'event', name: 'task.changed', table: 'events',
    source: 'data/projects/project.sqlite · events', status: '記録', updatedAt: '2026-01-04T17:06:00Z',
    eventId: 42, eventTask: task.name, eventPhase: '要件定義',
  } satisfies DataSummary;
  const savedDetails = {changes: [{field: 'name', value: '架空タスク'}]};
  const raw = {event_id: 42, type: event.name, at: event.updatedAt, task_id: task.id, phase: 'requirements', details: JSON.stringify(savedDetails)};
  const eventDetail = detail(event, {
    event: {type: event.name, at: event.updatedAt, taskId: task.id, taskName: task.name, phase: 'requirements', details: savedDetails},
    raw, related: [{id: task.id, name: 'タスクのDB行', view: 'db'}],
  });
  const request = stubFetch((path, params, init) => {
    if (path === '/api/data/sql') return response(init?.method === 'POST' ? sqlResult() : sqlCatalog(params.get('database')!));
    if (path === '/api/data') {
      if (params.get('view') === 'events') return response(list([event], {
        total: 51, offset: Number(params.get('offset')),
        eventTypes: params.get('scope') === 'all' ? [event.name, 'project.changed'] : [event.name],
      }));
      return response(list([document]));
    }
    if (params.get('view') === 'events') return response(eventDetail);
    expect(params.get('view')).toBe('db');
    return response(detail(task, {raw: {name: '元のタスク名'}, related: [{id: event.id, name: '変更イベント', view: 'events'}]}));
  });
  render(() => <DataPage />);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
    'ファイル', 'チャット', 'タスク', 'イベント', 'エージェント', 'DB',
  ]);
  fireEvent.click(screen.getByRole('tab', {name: 'イベント'}));
  const projectSelect = () => screen.getByRole<HTMLSelectElement>('combobox', {name: 'プロジェクト'});
  const typeSelect = () => screen.getByRole<HTMLSelectElement>('combobox', {name: 'イベント種類'});
  expect(await within(typeSelect()).findByRole('option', {name: 'project.changed'})).toBeTruthy();
  expect(within(projectSelect()).getAllByRole('option').map(option => option.textContent)).toEqual(['すべて', project.name]);
  fireEvent.change(typeSelect(), {target: {value: 'project.changed'}});
  fireEvent.change(projectSelect(), {target: {value: project.id}});
  expect(typeSelect().value).toBe('all');
  expect(await within(typeSelect()).findByRole('option', {name: event.name})).toBeTruthy();
  expect(within(typeSelect()).queryByRole('option', {name: 'project.changed'})).toBeNull();
  fireEvent.change(typeSelect(), {target: {value: event.name}});
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: '架空 タスク'}});
  expect(await screen.findByText('51 件')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '次のページ'}));
  const row = await screen.findByRole('button', {name: /^task\.changed/});
  for (const value of ['2026/01/05 02:06', task.name, '要件定義', '#42']) expect(row.textContent).toContain(value);
  const filters = {view: 'events', scope: project.id, eventType: event.name, query: '架空 タスク', offset: '50'};
  expect(request.mock.calls.at(-1)?.[0]).toBe(`/api/data?${new URLSearchParams({...filters, limit: '50'})}`);
  fireEvent.click(row);
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({...filters, id: event.id});
  expect(request.mock.calls.at(-1)?.[0]).toBe(`/api/data/detail?${new URLSearchParams({id: event.id, view: 'events'})}`);
  const eventPanel = () => within(screen.getByRole('tabpanel', {name: '内容'}));
  expect(await screen.findByRole('heading', {name: 'イベントの詳細'})).toBeTruthy();
  for (const value of ['2026/01/05 02:06', event.name, task.name, '要件定義']) expect(eventPanel().getByText(value)).toBeTruthy();
  expect(JSON.parse(eventPanel().getByText(/"changes"/).textContent!)).toEqual(savedDetails);
  expect(screen.queryByRole('combobox', {name: '版'})).toBeNull();
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  const storage = within(screen.getByRole('tabpanel', {name: '保存データ'}));
  expect(JSON.parse(storage.getByText(/"event_id"/).textContent!)).toEqual(raw);
  fireEvent.click(screen.getByRole('tab', {name: '内容'}));
  fireEvent.click(eventPanel().getByRole('button', {name: 'タスクのDB行'}));
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'db', id: task.id});
  expect(await screen.findByText('元のタスク名')).toBeTruthy();
  window.history.back();
  expect(await screen.findByRole('heading', {name: 'イベントの詳細'})).toBeTruthy();
  expect(projectSelect().value).toBe(project.id);
  expect(typeSelect().value).toBe(event.name);
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('架空 タスク');
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({...filters, id: event.id});
  window.history.forward();
  expect(await screen.findByText('元のタスク名')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '変更イベント'}));
  expect(await screen.findByRole('heading', {name: 'イベントの詳細'})).toBeTruthy();
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'events', id: event.id});
  fireEvent.click(screen.getByRole('tab', {name: 'チャット'}));
  expect(location.search).toBe('?view=chats');
  expect(screen.queryByRole('combobox', {name: 'イベント種類'})).toBeNull();
});

it('shows malformed event details as text and distinguishes empty events from source and request failures', async () => {
  const invalid = '<img src="example">\n{';
  const event = {...task, id: 'event/1', kind: 'event', name: 'legacy.event', eventId: 1} satisfies DataSummary;
  stubFetch((path, params) => {
    if (path === '/api/data/detail') return response(detail(event, {
      event: {type: event.name, at: null, taskId: task.id, taskName: null, phase: 'legacy-phase', details: invalid},
    }));
    if (params.get('query') === 'failure') return response({error: 'offline'}, 500);
    if (params.get('query') === 'missing') return response(list([], {errors: [{source: task.source, message: '読み取り失敗'}]}));
    return response(list([], {eventTypes: [event.name]}));
  });
  pop(`/data?view=events&eventType=${event.name}&id=${encodeURIComponent(event.id)}`);
  render(() => <DataPage />);
  expect(await screen.findByText('該当するデータがありません')).toBeTruthy();
  expect(await screen.findByRole('heading', {name: 'イベントの詳細'})).toBeTruthy();
  const panel = within(screen.getByRole('tabpanel', {name: '内容'}));
  const plain = panel.getByText(invalid, {normalizer: text => text});
  expect(plain.tagName).toBe('PRE');
  expect(plain.querySelector('img')).toBeNull();
  expect(panel.getByText(task.id)).toBeTruthy();
  expect(panel.getByText('legacy-phase')).toBeTruthy();
  expect(panel.getByText('不明')).toBeTruthy();
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: 'missing'}});
  expect(await screen.findByText('取得できなかった保存元（1 件）')).toBeTruthy();
  expect(screen.getByText('読み取れた保存元に該当するデータがありません')).toBeTruthy();
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: 'failure'}});
  expect((await screen.findByRole('alert')).textContent).toBe('データ一覧を取得できませんでした');
});

const workflow: DataSummary = {...chat, id: 'workflow-chat/1', name: 'ワークフロー · task.completed', status: 'failed', subtitle: task.name};
const agent: DataSummary = {...instruction, id: 'agent/example', kind: 'cache', name: '架空エージェント', status: 'ready', updatedAt: observedAt};

it('opens a workflow chat from a task and restores the task filters when returning', async () => {
  const taskRecord = {...task, subtitle: '要件定義', updatedAt: observedAt};
  const request = stubFetch((path, params) => {
    const view = params.get('view');
    if (path === '/api/data') return response(view === 'tasks'
      ? list([taskRecord], {statuses: ['idle', 'active'], offset: Number(params.get('offset')), total: 51})
      : list([workflow]));
    return response(view === 'tasks' ? detail(taskRecord, {
      task: {phase: 'requirements', status: 'idle', createdAt: '2026-01-01T16:00:00Z', updatedAt: observedAt,
        completedAt: '2026-01-01T16:01:00Z', completion: {revision: 'completed-revision'}, baseline: {revision: 'base-revision'}},
      related: [{id: workflow.id, name: '関連ジョブ', view: 'chats'}],
    }) : detail(workflow, {
      conversation: {
        version: 3, chatId: workflow.id, projectId: project.id, taskId: null, phase: null, workflowJobId: 'job/1',
        selectedModelId: null, providers: {}, messages: [{
          id: 'message', sendId: 'send', role: 'assistant', modelId: null, contentOverride: '実行時の発言',
          createdAt: observedAt, updatedAt: observedAt, status: 'completed', parts: [],
        }],
      },
      storageRows: [
        {source: 'data/beni.sqlite', table: 'instruction_jobs', row: {id: 'job/1'}},
        {source: 'data/projects/project.sqlite', table: 'tasks', row: {id: task.id}},
      ],
      workflow: {eventKey: 'task.completed', taskId: task.id, taskName: task.name, status: 'failed', provider: 'example',
        model: 'example-model', error: '記録された失敗理由', reason: '記録された結果の理由', revision: 'input-revision', instructionRevision: 'instruction-revision'},
    }));
  });
  const taskFilters = {view: 'tasks', scope: project.id, status: 'idle', query: '架空', offset: '50', id: task.id};
  pop(`/data?${new URLSearchParams(taskFilters)}`);
  render(() => <DataPage />);
  const contents = () => within(screen.getByRole('tabpanel', {name: '内容'}));
  const taskRow = await screen.findByRole('button', {name: /^架空タスク/});
  expect(taskRow.textContent).toContain('要件定義');
  expect(taskRow.textContent).toContain('idle');
  expect(taskRow.textContent).toContain('2026/01/03 00:04');
  expect(await screen.findByText('最終完了日時')).toBeTruthy();
  expect(contents().getByText('2026/01/02 01:00')).toBeTruthy();
  expect(contents().getByText('2026/01/02 01:01')).toBeTruthy();
  expect(contents().getByRole('heading', {name: '完了処理待ちの情報'})).toBeTruthy();
  expect(contents().getByText(/"revision": "completed-revision"/)).toBeTruthy();
  expect(contents().getByText(/"revision": "base-revision"/)).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>('combobox', {name: '状態'}).value).toBe('idle');
  expect(within(screen.getByRole('combobox', {name: 'プロジェクト'})).queryByRole('option', {name: 'アプリ共通'})).toBeNull();
  const {id: _taskId, ...taskListFilters} = taskFilters;
  expect(request.mock.calls.some(([path]) => path === `/api/data?${new URLSearchParams({...taskListFilters, limit: '50'})}`)).toBe(true);
  fireEvent.click(contents().getByRole('button', {name: '関連ジョブ'}));
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual({view: 'chats', id: workflow.id});
  expect(await screen.findByText('記録された失敗理由')).toBeTruthy();
  for (const value of ['failed', 'example-model', 'input-revision', 'instruction-revision', '記録された結果の理由', task.id, '実行時の発言']) {
    expect(contents().getByText(value)).toBeTruthy();
  }
  expect(within(screen.getByRole('combobox', {name: '所属'})).getByRole('option', {name: 'アプリ共通'})).toBeTruthy();
  const workflowRow = await screen.findByRole('button', {name: /^ワークフロー · task.completed/});
  expect(workflowRow.textContent).toContain(task.name);
  expect(workflowRow.textContent).toContain('failed');
  expect(screen.queryByRole('combobox', {name: '状態'})).toBeNull();
  expect(request.mock.calls.some(([path]) => path === '/api/data?view=chats&scope=all&query=&offset=0&limit=50')).toBe(true);
  fireEvent.click(screen.getByRole('tab', {name: '保存データ'}));
  const storage = within(screen.getByRole('tabpanel', {name: '保存データ'}));
  expect(storage.getByRole('heading', {name: '会話ファイルの JSON'})).toBeTruthy();
  expect(storage.getByRole('heading', {name: 'data/beni.sqlite · instruction_jobs'})).toBeTruthy();
  expect(storage.getByRole('heading', {name: 'data/projects/project.sqlite · tasks'})).toBeTruthy();
  window.history.back();
  expect(await screen.findByText('最終完了日時')).toBeTruthy();
  expect(Object.fromEntries(new URL(location.href).searchParams)).toEqual(taskFilters);
});

it('shows unchanged and unavailable version diffs for app instructions', async () => {
  const history = [
    {id:instruction.id,revision:'third',updatedAt:observedAt},
    {id:'instruction/2',revision:'second',updatedAt:'2026-01-01T16:02:03.000Z'},
    {id:'instruction/3',revision:'first',updatedAt:null},
  ];
  stubFetch((path, params) => {
    if (path === '/api/data') return response(list([instruction]));
    const id = params.get('id')!;
    return response(detail({...instruction,id}, {
      history,
      document: {revision: id === instruction.id ? 'third' : 'second', content:'共通本文',items:[]},
      documentDiff: id === instruction.id
        ? {state:'unchanged',previousRevision:'second'}
        : {state:'unavailable',previousRevision:'first',message:'前の版の本文を読み取れませんでした。'},
    }));
  });
  pop('/data?scope=app&kind=instruction');
  render(() => <DataPage />);
  expect(screen.queryByRole('tab', {name:'変更履歴'})).toBeNull();
  fireEvent.click(await screen.findByRole('button', {name:/^架空インストラクション/}));
  fireEvent.click(await screen.findByRole('tab', {name:'前の版との差分'}));
  expect(screen.getByText('本文に変更はありません')).toBeTruthy();
  expect(screen.getByText('比較元の版 2026/01/02 01:02')).toBeTruthy();
  const select = screen.getByRole('combobox', {name:'版'});
  fireEvent.change(select, {target:{value:'instruction/2'}});
  expect(await screen.findByText('前の版の本文を読み取れませんでした。')).toBeTruthy();
  expect(screen.getByRole('tab', {name:'前の版との差分'}).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('前の版はありません')).toBeNull();
});

it('reads only saved agent data and distinguishes invalidated, malformed and unavailable cache data', async () => {
  const resetsAt = Date.parse('2026-01-02T21:10:00Z') / 1000;
  const savedAgent: NonNullable<DataDetail['agent']> = {
    availability: 'ready', auth: 'api-key', version: '1.2.3', checkedAt: '2026-01-01T19:05:00Z',
    invalidated: true, models: [{id: 'example-model', name: '架空モデル'}],
    usage: {observedAt, windows: [{label: '架空の時間枠', usedPercent: 24.5, resetsAt}]}, issues: [],
  };
  let detailReads = 0;
  const request = stubFetch((path, params) => {
    if (path === '/api/data/detail') return response(detail(agent, {agent: ++detailReads === 1 ? savedAgent : {
      ...savedAgent, models: '{broken', usage: 'unknown', checkedAt: null, invalidated: false,
      issues: ['モデルの保存値が不正です'],
    }}));
    if (params.get('query') === 'error') return response({error: 'offline'}, 500);
    if (params.get('query') === 'empty') return response(list([], {statuses: ['ready']}));
    return response(list([agent], {statuses: ['ready', 'unavailable']}));
  });
  pop('/data?view=agents&status=ready');
  render(() => <DataPage />);
  const row = await screen.findByRole('button', {name: /^架空エージェント/});
  expect(row.textContent).toContain('ready');
  expect(screen.queryByRole('combobox', {name: '所属'})).toBeNull();
  expect(screen.getByRole<HTMLSelectElement>('combobox', {name: '利用可否'}).value).toBe('ready');
  expect(request.mock.calls[0]?.[0]).toBe('/api/data?view=agents&scope=app&status=ready&query=&offset=0&limit=50');
  fireEvent.click(row);
  expect(await screen.findByText('失効済み')).toBeTruthy();
  for (const value of ['api-key', '1.2.3', '架空の時間枠', '24.5%', '2026/01/02 04:05', '2026/01/03 06:10', 'example-model']) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.getByText('利用枠の取得日時 2026/01/03 00:04')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '更新'}));
  expect(await screen.findByText('モデルの保存値が不正です')).toBeTruthy();
  expect(screen.getByText('{broken')).toBeTruthy();
  expect(screen.getByRole('heading', {name: '保存済み利用枠'}).nextElementSibling?.textContent).toBe('未取得');
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: 'empty'}});
  expect(await screen.findByText('該当するデータがありません')).toBeTruthy();
  fireEvent.input(screen.getByRole('searchbox'), {target: {value: 'error'}});
  expect((await screen.findByRole('alert')).textContent).toBe('データ一覧を取得できませんでした');
});
