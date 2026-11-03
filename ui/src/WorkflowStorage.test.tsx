import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('fails closed and never dispatches when session storage cannot be read', async () => {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', {
    getItem: () => { throw new Error('storage unavailable'); },
    setItem: vi.fn(),
  });
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  const controller = await import('./workflowController');
  expect(controller.storageAvailable()).toBe(false);
  expect(controller.isBlocked(7301)).toBe(true);
  controller.scheduleRequirements(7301, true);
  const operation = vi.fn(async () => {});
  await controller.perform(7301, '実行中', operation);
  await Promise.resolve();
  expect(operation).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('fails closed for corrupt persisted JSON and never dispatches automatically', async () => {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', { getItem: () => '{invalid', setItem: vi.fn() });
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  const controller = await import('./workflowController');
  expect(controller.storageAvailable()).toBe(false);
  expect(controller.isBlocked(7302)).toBe(true);
  controller.scheduleRequirements(7302, true);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
});

it('does not run an operation when writing its confirmation marker fails', async () => {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => { throw new Error('storage full'); },
  });
  const controller = await import('./workflowController');
  const operation = vi.fn(async () => {});
  expect(controller.storageAvailable()).toBe(true);
  await controller.perform(7303, '実行中', operation);
  expect(operation).not.toHaveBeenCalled();
  expect(controller.storageAvailable()).toBe(false);
  expect(controller.isBlocked(7303)).toBe(true);
});

it.each([
  ['requirements', '指示書生成は未接続です'],
  ['plan', '計画生成は未接続です'],
  ['execution', '実行先は未接続です'],
  ['review', '監修先は未接続です'],
] as const)('treats the expected %s adapter 503 as a known pre-invocation rejection', async (kind, error) => {
  vi.resetModules();
  let marker = '';
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: (_key: string, value: string) => { marker = value; },
  });
  const request = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error }) }));
  vi.stubGlobal('fetch', request);
  const controller = await import('./workflowController');
  await controller.perform(7310, '処理中', () => controller.workflowPost('/api/example', {}, kind));
  expect(request).toHaveBeenCalledOnce();
  expect(controller.isBlocked(7310)).toBe(false);
  expect(controller.stateFor(7310).notice).toBe(error);
  expect(JSON.parse(marker)).toEqual([]);
});

it.each([
  ['different 503', 503, 'サービスが停止しています'],
  ['wrong adapter 503', 503, '計画生成は未接続です'],
  ['different status', 500, '指示書生成は未接続です'],
] as const)('preserves the confirmation marker for %s', async (_label, status, error) => {
  vi.resetModules();
  let marker = '';
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: (_key: string, value: string) => { marker = value; } });
  const request = vi.fn(async () => ({ ok: false, status, json: async () => ({ error }) }));
  vi.stubGlobal('fetch', request);
  const controller = await import('./workflowController');
  await controller.perform(7311, '処理中', () => controller.workflowPost('/api/example', {}, 'requirements'));
  expect(request).toHaveBeenCalledOnce();
  expect(controller.isBlocked(7311)).toBe(true);
  expect(controller.stateFor(7311).notice).toContain('処理結果を確認できません');
  expect(JSON.parse(marker)).toContain(7311);
});

it('preserves the confirmation marker when the network fails after dispatch', async () => {
  vi.resetModules();
  let marker = '';
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: (_key: string, value: string) => { marker = value; } });
  const request = vi.fn(async () => { throw new Error('connection lost'); });
  vi.stubGlobal('fetch', request);
  const controller = await import('./workflowController');
  await controller.perform(7312, '処理中', () => controller.workflowPost('/api/example', {}, 'requirements'));
  expect(request).toHaveBeenCalledOnce();
  expect(controller.isBlocked(7312)).toBe(true);
  expect(controller.stateFor(7312).notice).toContain('処理結果を確認できません');
  expect(JSON.parse(marker)).toContain(7312);
});
