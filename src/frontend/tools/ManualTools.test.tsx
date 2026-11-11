import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManualToolOperation, ManualToolRequest, ManualToolScope, ManualToolsCatalog } from '../../shared/manual-tools';
import Navbar from '../shared/components/Navbar';
import { resetModelCache } from '../shared/model-cache';

const scope = { kind: 'project', projectId: '019a0000-0000-7000-8000-000000000001', taskId: '019a0000-0000-7100-8000-00000000000b' } as const;
const url = `/api/tools?kind=project&projectId=${scope.projectId}&taskId=${scope.taskId}`;
const catalog: ManualToolsCatalog = {
  scope, revision: 'first', label: '架空プロジェクト / 架空タスク', phase: 'requirements',
  tools: [{
    name: 'sample_tool', description: '架空のツール', category: 'documents', effect: 'read',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'offset', 'value', 'mode', 'items'], properties: {
      name: { type: 'string' },
      offset: { type: 'integer', minimum: 0, maximum: 10 },
      enabled: { type: 'boolean' },
      value: { type: ['string', 'null'] },
      mode: { enum: ['first', 'second'] },
      items: { type: 'array', minItems: 1, items: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'], additionalProperties: false } },
      omitted: { type: 'string', default: 'default' },
    } },
  }],
};
const noArgsCatalog: ManualToolsCatalog = {
  ...catalog, tools: [{ ...catalog.tools[0], inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
};
const result = (request: ManualToolRequest, status: ManualToolOperation['status']): ManualToolOperation => ({
  id: request.operationId, scope, label: catalog.label, phase: catalog.phase, name: request.name, input: request.input, status,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  output: status === 'completed' ? '<img src="x" onerror="bad()">' : undefined,
});
function setup(handle: (url: string, init?: RequestInit) => Response | Promise<Response> = () => Response.json(noArgsCatalog)) {
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => path.startsWith('/api/tools') ? handle(path, init) : Response.json({ agents: [] }));
  vi.stubGlobal('fetch', fetcher);
  const [current, setCurrent] = createSignal<ManualToolScope | undefined>(scope);
  const mount = () => render(() => <Navbar title="架空" showHome onHome={() => {}} onData={() => {}} onInstructions={() => {}} onSettings={() => {}} toolScope={current()} />);
  mount();
  const open = () => {
    fireEvent.click(screen.getByRole('button', { name: 'ツール' }));
    return within(screen.getByRole('dialog', { name: 'ツール' }));
  };
  const select = async () => fireEvent.click(await screen.findByRole('button', { name: /sample_tool/ }));
  return { open, select, setCurrent, fetcher, mount };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetModelCache();
  vi.unstubAllGlobals();
});

it('keeps the modal keyboard focus, ignores backdrop clicks, and lists the current scope', async () => {
  const { open, select, setCurrent, fetcher } = setup();
  const trigger = screen.getByRole('button', { name: 'ツール' });
  expect(trigger.closest('li')?.nextElementSibling).toBe(screen.getByRole('button', { name: 'インストラクション管理' }).closest('li'));
  const view = open();
  const dialog = screen.getByRole('dialog', { name: 'ツール' });
  const heading = view.getByRole('heading', { name: 'ツール' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(await view.findByText(/架空プロジェクト.*要件定義/)).toBeTruthy();
  fireEvent.click(dialog);
  expect((dialog as HTMLDialogElement).open).toBe(true);
  await select();
  const close = view.getByRole('button', { name: '閉じる' });
  const run = view.getByRole('button', { name: '実行' });
  close.focus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(run);
  fireEvent.keyDown(run, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect((dialog as HTMLDialogElement).open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(fetcher.mock.calls.some(([path, init]) => path === '/api/tools' && init?.method === 'POST')).toBe(false);

  open();
  await select();
  setCurrent(undefined);
  await waitFor(() => expect((dialog as HTMLDialogElement).open).toBe(false));
  const home = open();
  expect(home.getByText('プロジェクトまたはインストラクション管理を開いてください')).toBeTruthy();
  expect(home.queryByText(catalog.label)).toBeNull();
});

it('validates typed fields and preserves null, false, zero, empty text, and omitted arguments', async () => {
  const received: ManualToolRequest[] = [];
  const { open, select } = setup((path, init) => {
    if (path === url) return Response.json(catalog);
    const request = JSON.parse(String(init?.body)) as ManualToolRequest;
    received.push(request);
    return Response.json({ operation: result(request, 'completed') }, { status: 202 });
  });
  const view = open();
  await select();
  expect(received).toHaveLength(0);
  const change = (name: string, value: string) => fireEvent.input(view.getByLabelText(name), { target: { value } });
  change('offset', '1.5');
  change('items', '[{"index":0,"extra":true}]');
  fireEvent.click(view.getByRole('checkbox', { name: 'enabled を指定する' }));
  fireEvent.click(view.getByRole('checkbox', { name: 'value に null を指定' }));
  fireEvent.change(view.getByRole('combobox', { name: 'mode' }), { target: { value: '1' } });
  expect(view.getByRole('checkbox', { name: /^enabled$/ })).toHaveProperty('checked', false);
  const run = view.getByRole('button', { name: '実行' });
  fireEvent.click(run);
  expect(view.getAllByRole('alert')).toHaveLength(2);
  expect(received).toHaveLength(0);
  change('offset', '0');
  change('items', '[{"index":0}]');
  fireEvent.click(run);
  fireEvent.click(run);
  await view.findByText('完了');
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ scope, revision: catalog.revision, name: 'sample_tool', input: {
    name: '', offset: 0, enabled: false, value: null, mode: 'second', items: [{ index: 0 }],
  } });
  expect(Object.hasOwn(received[0].input, 'omitted')).toBe(false);
  const output = await view.findByText('<img src="x" onerror="bad()">');
  expect(output.querySelector('img')).toBeNull();
});

it('restores a submitted operation by ID and retains its original target after navigation', async () => {
  let request: ManualToolRequest | undefined;
  const { open, select, setCurrent, fetcher, mount } = setup((path, init) => {
    if (path === url) return Response.json(noArgsCatalog);
    if (path === '/api/tools' && init?.method === 'POST') {
      request = JSON.parse(String(init.body));
      return Promise.reject(Error('通信切断'));
    }
    if (path.startsWith('/api/tools/operations/') && request) {
      expect(path).toBe(`/api/tools/operations/${request.operationId}?${url.split('?')[1]}`);
      return Response.json({ operation: result(request, 'completed') });
    }
    throw Error('Unexpected request');
  });
  let view = open();
  await select();
  fireEvent.click(view.getByRole('button', { name: '実行' }));
  setCurrent({ kind: 'instructions' });
  await view.findByText('完了');
  expect(view.getByText(/対象：架空プロジェクト.*要件定義/)).toBeTruthy();
  cleanup();
  expect(sessionStorage.getItem(`beni.manual-tool:${url.split('?')[1]}`)).toBe(request?.operationId);
  setCurrent(scope);
  mount();
  view = open();
  await view.findByText('完了');
  expect(view.getByText(/対象：架空プロジェクト.*要件定義/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([path]) => path.startsWith('/api/tools/operations/'))).toHaveLength(2);
});

it('retries catalog errors and refreshes a stale revision without resending', async () => {
  let reads = 0;
  const { open, select, fetcher } = setup((path) => {
    if (path === url) {
      if (++reads === 1) return Response.json({ error: '一覧取得エラー' }, { status: 503 });
      return Response.json({ ...noArgsCatalog, revision: reads > 2 ? 'second' : 'first' });
    }
    return Response.json({ error: 'ツール定義が変更されました' }, { status: 409 });
  });
  const view = open();
  expect((await view.findByRole('alert')).textContent).toBe('一覧取得エラー');
  fireEvent.click(view.getByRole('button', { name: '一覧を再取得' }));
  await select();
  fireEvent.click(view.getByRole('button', { name: '実行' }));
  expect((await view.findByRole('alert')).textContent).toBe('ツール定義が変更されました');
  fireEvent.click(view.getByRole('button', { name: '一覧を再取得' }));
  expect(await view.findByRole('button', { name: /sample_tool/ })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('lets the user end repeated 404 checks and reopen the catalog without resending', async () => {
  vi.useFakeTimers();
  try {
    const { open, fetcher } = setup((path, init) => {
      if (path === url) return Response.json(noArgsCatalog);
      if (init?.method === 'POST') return Promise.reject(Error('通信切断'));
      return Response.json({ error: '操作が見つかりません' }, { status: 404 });
    });
    const view = open();
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(view.getByRole('button', { name: /sample_tool/ }));
    fireEvent.click(view.getByRole('button', { name: '実行' }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(view.getByText('結果不明')).toBeTruthy();
    expect(view.getByText('操作はすでに実行された可能性があります。')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '照合を終了して閉じる' }));
    const reopened = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.getByRole('button', { name: /sample_tool/ })).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('blocks a stale form and closes it when the current phase changes', async () => {
  vi.useFakeTimers();
  try {
    let phase: ManualToolsCatalog['phase'] = 'requirements';
    let revision = 'first';
    const { open, fetcher } = setup(() => Response.json({ ...noArgsCatalog, phase, revision }));
    const view = open();
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(view.getByRole('button', { name: /sample_tool/ }));
    const run = view.getByRole('button', { name: '実行' });
    expect(run).toHaveProperty('disabled', false);
    revision = 'second';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveProperty('disabled', true);
    expect(view.getByRole('alert').textContent).toContain('一覧を取得し直してください');
    phase = 'documents';
    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.queryByRole('dialog', { name: 'ツール' })).toBeNull();
    const reopened = open();
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.getByText(/対象：架空プロジェクト.*仕様整理/)).toBeTruthy();
    expect(reopened.queryByRole('button', { name: '実行' })).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves fields of schemas edited as a JSON object', async () => {
  const received: ManualToolRequest[] = [];
  const { open, select } = setup((path, init) => {
    if (path === url) return Response.json({
      ...noArgsCatalog, tools: [{ ...noArgsCatalog.tools[0], inputSchema: {
        type: 'object', properties: { value: { type: 'integer' } }, required: ['value'],
      } }],
    });
    const request = JSON.parse(String(init?.body)) as ManualToolRequest;
    received.push(request);
    return Response.json({ operation: result(request, 'completed') });
  });
  const view = open();
  await select();
  const input = view.getByRole('textbox', { name: '引数（JSON オブジェクト）' });
  const run = view.getByRole('button', { name: '実行' });
  fireEvent.input(input, { target: { value: '{"value":' } });
  fireEvent.click(run);
  expect(view.getByRole('alert').textContent).toContain('JSON オブジェクト');
  expect(received).toHaveLength(0);
  fireEvent.input(input, { target: { value: '{"value":0,"custom":{"empty":null}}' } });
  fireEvent.click(run);
  await view.findByText('完了');
  expect(received[0].input).toEqual({ value: 0, custom: { empty: null } });
});
