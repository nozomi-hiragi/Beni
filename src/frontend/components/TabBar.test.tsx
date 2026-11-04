import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import TabBar from './TabBar';

afterEach(cleanup);

it('keeps the left action outside the scrolling tabs and right action and dispatches each operation', () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onTree = vi.fn();
  const onAdd = vi.fn();
  render(() => <TabBar label="文書" tabs={[{ id: 'a', label: '指示書' }, { id: 'b', label: '計画' }]} activeId="a" onSelect={onSelect} onClose={onClose} left={<button type="button" onClick={onTree}>ツリー</button>} right={<button type="button" onClick={onAdd}>追加</button>} />);

  const list = screen.getByRole('tablist', { name: '文書' });
  const scroll = list.parentElement!;
  expect(scroll.className).toContain('overflow-x-auto');
  expect(scroll.contains(screen.getByRole('button', { name: 'ツリー' }))).toBe(false);
  expect(list.nextElementSibling?.contains(screen.getByRole('button', { name: '追加' }))).toBe(true);
  expect(screen.getByRole('tab', { name: '指示書' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: '計画' }));
  fireEvent.click(screen.getByRole('button', { name: '計画 を閉じる' }));
  fireEvent.click(screen.getByRole('button', { name: 'ツリー' }));
  fireEvent.click(screen.getByRole('button', { name: '追加' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('b');
  expect(onClose).toHaveBeenCalledExactlyOnceWith('b');
  expect(onTree).toHaveBeenCalledOnce();
  expect(onAdd).toHaveBeenCalledOnce();
});

it('does not render optional controls when not supplied', () => {
  render(() => <TabBar label="文書" tabs={[{ id: 'a', label: '指示書' }]} activeId="a" onSelect={() => {}} />);
  expect(screen.queryByRole('button', { name: '指示書 を閉じる' })).toBeNull();
  expect(screen.getByRole('tab', { name: '指示書' })).toBeTruthy();
});
