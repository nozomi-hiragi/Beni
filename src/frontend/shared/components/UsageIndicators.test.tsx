import { stubLegacyAgentFetch } from '../../test/test-events';
import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { refreshProviderStatus, resetModelCache } from '../model-cache';
import type { ProviderUsage } from '../types';
import UsageIndicators from './UsageIndicators';

const usage = (windows: Exclude<ProviderUsage, 'unknown'>['windows']): ProviderUsage => ({
  observedAt: '2026-01-02T03:04:05Z',
  windows,
});

afterEach(() => { cleanup(); resetModelCache(); vi.unstubAllGlobals(); });

it('loads cached balances for detected providers and reflects a settings refresh', async () => {
  const sessionReset = new Date(2026, 0, 2, 13, 30);
  const weekReset = new Date(2026, 0, 7, 9, 15);
  const fetchStatus = vi.fn(async (path: string, init?: RequestInit) => {
    const status = path === '/api/codex/status'
      ? { installed: true, usage: init?.method === 'POST'
        ? usage([{ label: '5時間枠', usedPercent: 0 }])
        : usage([
          { label: '5時間枠', usedPercent: 100, resetsAt: sessionReset.getTime() / 1000 },
          { label: '7日枠', usedPercent: 25, resetsAt: weekReset.getTime() / 1000 },
        ]) }
      : { installed: false, usage: 'unknown' };
    return new Response(JSON.stringify(status));
  });
  stubLegacyAgentFetch(fetchStatus);
  render(() => <UsageIndicators />);

  const codex = await screen.findByRole('progressbar', { name: 'Codex の利用枠' });
  expect(codex.getAttribute('aria-valuenow')).toBe('0');
  expect(codex.tabIndex).toBe(0);
  expect(codex.querySelector('svg')).toBeTruthy();
  const tooltip = screen.getByRole('tooltip');
  expect(codex.getAttribute('aria-describedby')).toBe(tooltip.id);
  expect(tooltip.textContent).toContain('5時間 残り 0%');
  expect(tooltip.textContent).toContain('週間 残り 75%');
  const format: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' };
  expect(tooltip.textContent).toContain(`5時間 残り 0%リセット: ${sessionReset.toLocaleString(undefined, format)}`);
  expect(tooltip.textContent).toContain(`週間 残り 75%リセット: ${weekReset.toLocaleString(undefined, format)}`);
  expect(screen.queryByRole('progressbar', { name: 'Claude の利用枠' })).toBeNull();
  expect(fetchStatus.mock.calls).toEqual([
    ['/api/codex/status', undefined],
    ['/api/claude/status', undefined],
  ]);

  await refreshProviderStatus('codex');
  expect(codex.getAttribute('aria-valuenow')).toBe('100');
  expect(tooltip.textContent).toContain('週間 未取得');
  expect(tooltip.textContent).toContain('週間 未取得リセット: 未取得');
});

it('uses a shared weekly balance as fallback and leaves unavailable percentages unknown', async () => {
  stubLegacyAgentFetch(vi.fn(async (path: string) => new Response(JSON.stringify({
    installed: true,
    usage: path === '/api/codex/status'
      ? usage([{ label: '7日枠', usedPercent: 40 }])
      : usage([
        { label: '5時間枠', status: 'allowed', resetsAt: 1e16 },
        { label: '7日枠 · Sonnet', usedPercent: 0, resetsAt: 2_000_000_000 },
      ]),
  }))));
  render(() => <UsageIndicators />);

  const codex = await screen.findByRole('progressbar', { name: 'Codex の利用枠' });
  expect(codex.getAttribute('aria-valuenow')).toBe('60');
  expect(codex.getAttribute('aria-valuetext')).toBe('週間 残り 60%');
  const claude = await screen.findByRole('progressbar', { name: 'Claude の利用枠' });
  expect(claude.getAttribute('aria-valuenow')).toBeNull();
  expect(claude.getAttribute('aria-valuetext')).toBe('未取得');
  const tooltip = document.getElementById(claude.getAttribute('aria-describedby')!);
  expect(tooltip?.textContent).toContain('5時間 未取得リセット: 未取得');
  expect(tooltip?.textContent).toContain('週間 未取得リセット: 未取得');
});
