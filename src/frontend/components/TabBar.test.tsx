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

it('renames the targeted inactive task in place with keyboard, IME, cancellation and validation', async () => {
  const onRename = vi.fn().mockRejectedValueOnce(new Error('保存失敗')).mockResolvedValue(undefined);
  const onSelect = vi.fn();
  render(() => <TabBar label="チャット" tabs={[{id:'general',label:'General',closable:false},{id:'a',label:'作業A',renameable:true},{id:'b',label:'作業B',renameable:true}]} activeId="a" onSelect={onSelect} onRename={onRename} />);
  fireEvent.contextMenu(screen.getByRole('tab',{name:'General'}));
  expect(screen.queryByRole('menu')).toBeNull();
  const target = () => screen.getByRole('tab',{name:'作業B'});
  fireEvent.contextMenu(target(),{clientX:20,clientY:20});
  fireEvent.click(screen.getByRole('menuitem',{name:'リネーム'}));
  const input = screen.getByRole('textbox',{name:'タスク名'}) as HTMLInputElement;
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(3);
  fireEvent.input(input,{target:{value:'新しい名前'}});
  fireEvent.keyDown(input,{key:'Enter',isComposing:true});
  expect(onRename).not.toHaveBeenCalled();
  fireEvent.keyDown(input,{key:'Escape'});
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.keyDown(target(),{key:'F10',shiftKey:true});
  fireEvent.click(screen.getByRole('menuitem',{name:'リネーム'}));
  const next = screen.getByRole('textbox');
  fireEvent.input(next,{target:{value:'   '}});fireEvent.keyDown(next,{key:'Enter'});
  expect(screen.getByRole('alert').textContent).toBe('タスク名を入力してください');
  expect(onRename).not.toHaveBeenCalled();
  fireEvent.input(next,{target:{value:'  新しい名前  '}});fireEvent.keyDown(next,{key:'Enter'});
  await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('保存失敗'));
  fireEvent.keyDown(next,{key:'Enter'});
  await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(onRename).toHaveBeenLastCalledWith('b','新しい名前');
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(target(),{key:'ContextMenu'});fireEvent.click(screen.getByRole('menuitem'));
  fireEvent.blur(screen.getByRole('textbox'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onRename).toHaveBeenCalledTimes(2);
  fireEvent.contextMenu(target());fireEvent.click(screen.getByRole('menuitem'));
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});
  expect(onRename).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('confirms deletion of the targeted task, cancels safely and retains failures for retry', async () => {
  const onDelete = vi.fn().mockRejectedValueOnce(new Error('タスクは実行中です')).mockResolvedValue(undefined);
  const onSelect = vi.fn();
  render(() => <TabBar label="チャット" tabs={[{id:'general',label:'General',closable:false},{id:'a',label:'作業A',deletable:true},{id:'b',label:'作業B',deletable:true}]} activeId="a" onSelect={onSelect} onDelete={onDelete} />);
  fireEvent.contextMenu(screen.getByRole('tab',{name:'General'}));
  expect(screen.queryByRole('menu')).toBeNull();
  const open = () => { fireEvent.contextMenu(screen.getByRole('tab',{name:'作業B'})); fireEvent.click(screen.getByRole('menuitem',{name:'削除'})); };
  open();
  expect(screen.getByRole('alertdialog').textContent).toContain('「作業B」を削除');
  expect(screen.getByRole('alertdialog').textContent).toContain('文書とチャット履歴');
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'キャンセル'}));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  open(); fireEvent.click(screen.getByRole('button',{name:'OK'}));
  await vi.waitFor(() => expect(screen.getByRole('alert').textContent).toBe('タスクは実行中です'));
  expect(screen.getByRole('tab',{name:'作業B'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'OK'}));
  await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(onDelete).toHaveBeenNthCalledWith(1,'b');
  expect(onDelete).toHaveBeenNthCalledWith(2,'b');
  expect(onSelect).not.toHaveBeenCalled();
});

it('does not offer deletion for document tabs', () => {
  render(() => <TabBar label="文書" tabs={[{id:'a',label:'requirements.md'}]} activeId="a" onSelect={() => {}} onDelete={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole('tab'));
  expect(screen.queryByRole('menu')).toBeNull();
});
