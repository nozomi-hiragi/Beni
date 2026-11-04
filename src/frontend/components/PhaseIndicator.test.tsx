import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import PhaseIndicator from './PhaseIndicator';

afterEach(cleanup);

it('opens the available requirements and keeps unconnected phases disabled', () => {
  const onRequirements = vi.fn();
  render(() => <PhaseIndicator phase="requirements" onRequirements={onRequirements} />);
  const requirements = screen.getByRole('button', { name: 'タスク内容' });
  expect(requirements.getAttribute('aria-current')).toBe('step');
  fireEvent.click(requirements);
  expect(onRequirements).toHaveBeenCalledOnce();
  for (const name of ['実装フロー', '実装中', '高モデルに依頼']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});
