import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import TreeView from './TreeView';

afterEach(cleanup);

it('renders nested groups and selects a leaf using its stable id', () => {
  const onSelect = vi.fn();
  render(() => <TreeView id="test-tree" label="ファイル" nodes={[
    { label: 'docs', children: [
      { id: 'one', label: '指示書.md' },
      { label: 'archive', children: [{ id: 'two', label: '計画.md' }] },
    ] },
  ]} onSelect={onSelect} />);
  const panel = screen.getByRole('complementary', { name: 'ファイル' });
  expect(panel.id).toBe('test-tree');
  expect(screen.getByText('docs').closest('details')?.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '計画.md' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('two');
});
