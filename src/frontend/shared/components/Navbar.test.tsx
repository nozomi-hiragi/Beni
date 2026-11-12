import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { loadModels, resetModelCache } from '../model-cache';
import Navbar from './Navbar';

afterEach(() => { cleanup(); resetModelCache(); vi.unstubAllGlobals(); });

it('displays the current title and only shows the home button outside home', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({agents: []})));
  const onHome = vi.fn();
  const onSettings = vi.fn();
  const onInstructions = vi.fn();
  const [title, setTitle] = createSignal('Beni');
  const [showHome, setShowHome] = createSignal(false);
  render(() => <Navbar title={title()} showHome={showHome()} onHome={onHome} onData={vi.fn()} onSettings={onSettings} onInstructions={onInstructions} />);

  expect(screen.getByText('Beni')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'ホームへ戻る' })).toBeNull();
  expect(screen.queryByRole('searchbox')).toBeNull();
  const settingsButton = screen.getByRole('button', { name: '設定' });
  const instructionsButton = screen.getByRole('button', { name: 'インストラクション管理' });
  expect(instructionsButton.closest('li')?.nextElementSibling).toBe(settingsButton.closest('li'));
  expect(instructionsButton.getAttribute('data-tip')).toBe('インストラクション管理');
  expect(settingsButton.getAttribute('data-tip')).toBe('設定');
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
  await loadModels();
});
