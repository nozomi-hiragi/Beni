import { Show } from 'solid-js';
import HomeIcon from './icons/HomeIcon';
import DocumentIcon from './icons/DocumentIcon';
import DataIcon from './icons/DataIcon';
import SettingsIcon from './icons/SettingsIcon';
import UsageIndicators from './UsageIndicators';
import type { ManualToolScope } from '../../../shared/manual-tools';
import ManualTools from '../../tools/ManualTools';

export interface NavbarProps {
  title: string;
  toolScope?: ManualToolScope;
  toolsUnavailable?: string;
  toolsPage?: string;
  showHome: boolean;
  onHome: () => void;
  onData: () => void;
  onInstructions: () => void;
  onSettings: () => void;
}

export default function Navbar(props: NavbarProps) {
  return <header class="navbar relative z-10 w-auto mx-2 mt-2 rounded-box border border-base-300 bg-base-100 shadow-sm min-h-10 flex-wrap items-center gap-3 px-4 py-2">
    <Show when={props.showHome}>
      <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="ホームへ戻る" onClick={props.onHome}>
        <HomeIcon />
      </button>
    </Show>
    <ManualTools scope={props.toolScope} page={props.toolsPage} unavailable={props.toolsUnavailable} />
    <strong class="min-w-0 truncate text-lg font-semibold tracking-tight">{props.title}</strong>
    <span class="flex-1" aria-hidden="true" />
    <UsageIndicators />
    <ul class="menu menu-horizontal rounded-box p-1">
      <li>
        <button type="button" class="tooltip tooltip-bottom" data-tip="データ" aria-label="データ" onClick={props.onData}>
          <DataIcon />
        </button>
      </li>
      <li>
        <button type="button" class="tooltip tooltip-bottom" data-tip="インストラクション管理" aria-label="インストラクション管理" onClick={props.onInstructions}>
          <DocumentIcon />
        </button>
      </li>
      <li>
        <button type="button" class="tooltip tooltip-bottom" data-tip="設定" aria-label="設定" onClick={props.onSettings}>
          <SettingsIcon />
        </button>
      </li>
    </ul>
  </header>;
}
