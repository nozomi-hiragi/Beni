import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import PhaseIndicator from './PhaseIndicator';
afterEach(cleanup);
it('selects preparation phases directly and starts only with a plan',()=>{
 const onChange=vi.fn();render(()=><PhaseIndicator phase="documents" onChange={onChange} canStart />);
 for(const [label,phase] of [['要件定義','requirements'],['仕様整理','documents'],['実装手順','implementation']]){fireEvent.click(screen.getByRole('button',{name:label}));expect(onChange).toHaveBeenLastCalledWith(phase)}
 fireEvent.click(screen.getByRole('button',{name:'開始'}));expect(onChange).toHaveBeenLastCalledWith('start');
 expect(screen.queryByRole('button',{name:'戻る'})).toBeNull();expect(screen.queryByRole('button',{name:'確定'})).toBeNull();
});
it('disables start without a plan and duplicate changes while saving',()=>{
 const onChange=vi.fn();render(()=><PhaseIndicator phase="requirements" onChange={onChange} advancing />);
 fireEvent.click(screen.getByRole('button',{name:'開始'}));fireEvent.click(screen.getByRole('button',{name:'実装手順'}));expect(onChange).not.toHaveBeenCalled();
});
it('locks phase selection during implementation and exposes stop',()=>{
 const onChange=vi.fn();render(()=><PhaseIndicator phase="execution" onChange={onChange} />);
 fireEvent.click(screen.getByRole('button',{name:'要件定義'}));expect(onChange).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'停止'}));expect(onChange).toHaveBeenCalledWith('stop');expect(screen.getByText('実装中').getAttribute('aria-current')).toBe('step');
});
it('反省会では準備に戻れず、応答中は完了できない', () => {
 const onChange=vi.fn();render(()=><PhaseIndicator phase="retrospective" onChange={onChange} busy />);
 expect(screen.queryByRole('button',{name:'開始'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'要件定義'}));fireEvent.click(screen.getByRole('button',{name:'タスク完了'}));expect(onChange).not.toHaveBeenCalled();
 expect(screen.getByText('反省会').getAttribute('aria-current')).toBe('step');
});
it('完了済みは再開を表示する', () => {
 const onChange=vi.fn();render(()=><PhaseIndicator phase="retrospective" onChange={onChange} completed />);
 fireEvent.click(screen.getByRole('button',{name:'再開'}));expect(onChange).toHaveBeenCalledWith('reopen');
});
