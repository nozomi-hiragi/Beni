import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import PhaseIndicator from './PhaseIndicator';

afterEach(cleanup);

it('opens each fixed document and advances the current phase', () => {
  const onDocument = vi.fn(), onChange = vi.fn();
  render(() => <PhaseIndicator phase="documents" onDocument={onDocument} onChange={onChange} />);
  for (const [label, name] of [['要件定義', 'requirements.md'], ['仕様整理', 'documents.md'], ['実装手順', 'implementation-plan.md']]) {
    const button = screen.getByRole('button', {name: label});
    expect(button.getAttribute('aria-current')).toBe(label === '仕様整理' ? 'step' : null);
    expect(button.classList.contains('btn-active')).toBe(label === '仕様整理');
    fireEvent.click(button);
    expect(onDocument).toHaveBeenLastCalledWith(name);
  }
  fireEvent.click(screen.getByRole('button', {name: '確定'}));
  expect(onChange).toHaveBeenCalledWith('next');
  fireEvent.click(screen.getByRole('button', {name: '戻る'}));
  expect(onChange).toHaveBeenLastCalledWith('back');
  expect(screen.queryByRole('button', {name: '実装中'})).toBeNull();
});

it('prevents duplicate advancement while saving', () => {
  const onChange = vi.fn();
  render(() => <PhaseIndicator phase="implementation-plan" onDocument={() => {}} onChange={onChange} advancing />);
  fireEvent.click(screen.getByRole('button', {name: '実行指示'}));
  expect(onChange).not.toHaveBeenCalled();
});

it('shows implementation as a clearly highlighted current step without a disabled button', () => {
  render(() => <PhaseIndicator phase="implementation" onDocument={() => {}} onChange={() => {}} />);
  const current = screen.getByText('実装中');
  expect(current.getAttribute('aria-current')).toBe('step');
  expect(current.classList.contains('bg-base-300')).toBe(true);
  expect(current.classList.contains('text-base-content')).toBe(true);
  expect(current.hasAttribute('disabled')).toBe(false);
  expect(screen.queryByRole('button', {name: '確定'})).toBeNull();
});

it.each(['requirements', 'unknown'])('hides back for %s', phase => {
  render(() => <PhaseIndicator phase={phase} onDocument={() => {}} onChange={() => {}} />);
  expect(screen.queryByRole('button', {name: '戻る'})).toBeNull();
});
