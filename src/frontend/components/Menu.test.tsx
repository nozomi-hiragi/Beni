import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import Menu from './Menu';

afterEach(cleanup);

it('displays the current title and only shows the home button outside home', () => {
  const onHome = vi.fn();
  const onSettings = vi.fn();
  const onInstructions = vi.fn();
  const [title, setTitle] = createSignal('Beni');
  const [showHome, setShowHome] = createSignal(false);
  const [query, setQuery] = createSignal('');
  render(() => <Menu title={title()} showHome={showHome()} query={query()} onHome={onHome} onSettings={onSettings} onInstructions={onInstructions} onQueryChange={setQuery} />);

  expect(screen.getByText('Beni')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'ホームへ戻る' })).toBeNull();
  const search = screen.getByRole('searchbox', { name: 'タスクを検索' }) as HTMLInputElement;
  fireEvent.input(search, { target: { value: '画面' } });
  expect(query()).toBe('画面');
  const settingsButton = screen.getByRole('button', { name: '設定' });
  const instructionsButton = screen.getByRole('button', { name: 'インストラクション管理' });
  expect(instructionsButton.nextElementSibling).toBe(settingsButton);
  expect(instructionsButton.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(instructionsButton);
  expect(onInstructions).toHaveBeenCalledOnce();
  const settingsIcon = settingsButton.querySelector('svg');
  expect(settingsIcon?.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(settingsButton);
  expect(onSettings).toHaveBeenCalledOnce();

  setTitle('架空プロジェクト');
  setShowHome(true);
  expect(screen.getByText('架空プロジェクト')).toBeTruthy();
  const homeButton = screen.getByRole('button', { name: 'ホームへ戻る' });
  const homeIcon = homeButton.querySelector('svg');
  expect(homeIcon?.getAttribute('aria-hidden')).toBe('true');
  expect(homeIcon?.getAttribute('viewBox')).toBe(settingsIcon?.getAttribute('viewBox'));
  expect(homeIcon?.getAttribute('stroke-width')).toBe(settingsIcon?.getAttribute('stroke-width'));
  fireEvent.click(homeButton);
  expect(onHome).toHaveBeenCalledOnce();
  setTitle('設定');
  expect(screen.getByText('設定', { selector: 'strong' })).toBeTruthy();
  expect(search.value).toBe('画面');
});
