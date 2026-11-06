import { createSignal, For, onMount, Show } from 'solid-js';
import { loadModels, modelStatus, providerName, refreshProviderStatus } from '../model-cache';
import type { Provider, ProviderUsage, UsageWindow } from '../types';

function usageStatusLabel(status: UsageWindow['status']) {
  switch (status) {
    case 'allowed': return '利用可能';
    case 'allowed_warning': return '残りわずか';
    case 'rejected': return '利用不可';
    default: return '状態不明';
  }
}
function formatDate(value: string | number | undefined) {
  if (value === undefined) return '未確認';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? '未確認' : date.toLocaleString();
}

function Connection(props: {provider: Provider}) {
  const status = () => modelStatus(props.provider);
  const name = () => providerName(props.provider);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [usageRequested, setUsageRequested] = createSignal(false);
  async function loadConnection() {
    setLoading(true); setError('');
    try { await loadModels(true, props.provider); }
    catch { setError(`${name()} の状態を確認できませんでした`); }
    finally { setLoading(false); }
  }
  async function refresh() {
    setLoading(true); setError('');
    try {
      await refreshProviderStatus(props.provider);
      setUsageRequested(true);
    } catch { setError(`${name()} の利用枠を取得できませんでした`); }
    finally { setLoading(false); }
  }
  onMount(loadConnection);
  const unsupported = () => {
    if (props.provider !== 'claude' || !status()?.version) return false;
    const version = status()!.version!.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!version) return true;
    const [major, minor, patch] = version.slice(1).map(Number);
    return major! < 2 || major === 2 && (minor! < 1 || minor === 1 && patch! < 292);
  };
  const authLabel = () => {
    if (unsupported()) return 'Claude Code 2.1.292 以降に更新してください';
    switch (status()?.auth) {
      case 'chatgpt': return 'ChatGPT でログイン済み';
      case 'claude': return 'Claude Code サブスクリプションでログイン済み';
      case 'apiKey': return 'API キーで認証中';
      case 'other': return 'その他の認証方式';
      case 'none': return `${name()} にログインしてください`;
      default: return '未確認';
    }
  };
  const usage = () => status()?.usage;
  const usageInfo = (): Exclude<ProviderUsage, 'unknown'> | undefined => {
    const value = usage();
    return value && value !== 'unknown' ? value : undefined;
  };
  return <div class="card card-border border-base-300 bg-base-100 shadow-sm mt-6 p-6">
    <div class="flex items-center justify-between gap-4"><h2 class="text-[.95rem] font-bold">{name()} 接続</h2><button type="button" class="btn btn-sm" aria-label={`${name()} の接続状態を更新`} disabled={loading()} onClick={refresh}>{loading() ? '確認中...' : '更新'}</button></div>
    <Show when={error()}><p role="alert" class="mt-3 text-sm text-error">{error()}</p></Show>
    <dl class="mt-4 space-y-2 text-sm"><div><dt class="inline font-medium">実行ファイル: </dt><dd class="inline">{status() ? status()!.installed ? '検出済み' : `${name()} CLI をインストールしてください` : '未確認'}</dd></div><div><dt class="inline font-medium">パス: </dt><dd class="inline break-all">{status()?.path ?? '未確認'}</dd></div><div><dt class="inline font-medium">バージョン: </dt><dd class="inline">{status()?.version ?? '未確認'}</dd></div><div><dt class="inline font-medium">確認日時: </dt><dd class="inline">{status()?.checkedAt ? new Date(status()!.checkedAt).toLocaleString() : '未確認'}</dd></div><div><dt class="inline font-medium">認証: </dt><dd class="inline">{authLabel()}</dd></div><div><dt class="inline font-medium">モデル: </dt><dd class="inline"><Show when={status()?.models} fallback="未確認"><For each={status()!.models!}>{(model, index) => <>{index() > 0 ? '、' : ''}{model.name}</>}</For><Show when={status()!.models!.length === 0}>取得できるモデルはありません</Show></Show></dd></div></dl>
    <div class="mt-4 border-t border-base-300 pt-4">
      <h3 class="text-sm font-semibold">利用枠</h3>
      <Show when={usageInfo()} fallback={<p class="mt-2 text-sm text-base-content/70">{usageRequested() ? '利用枠の情報を取得できませんでした' : '未取得（「更新」で確認できます）'}</p>}>
        {(current) => <>
          <p class="mt-2 text-xs text-base-content/70">最終取得: {formatDate(current().observedAt)}</p>
          <Show when={current().windows.length > 0} fallback={<p class="mt-2 text-sm text-base-content/70">利用枠の情報はありません</p>}>
            <dl class="mt-2 space-y-2 text-sm">
              <For each={current().windows}>{window => <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                <dt class="font-medium">{window.label}</dt>
                <dd class="text-right">{window.usedPercent !== undefined ? `残り ${Math.round(100 - window.usedPercent)}%` : usageStatusLabel(window.status)}</dd>
                <Show when={window.resetsAt !== undefined}>
                  <dt class="text-xs text-base-content/70">リセット</dt><dd class="text-right text-xs text-base-content/70">{formatDate(window.resetsAt)}</dd>
                </Show>
              </div>}</For>
            </dl>
          </Show>
        </>}
      </Show>
    </div>
    <Show when={props.provider === 'claude'}><p class="mt-4 text-sm text-base-content/70">Claude Code 2.1.292 以降とサブスクリプションのログインが必要です。タスクではファイル編集とコマンド実行ができます。ネットワークと外部ツールは無効です。</p></Show>
  </div>;
}
export default function CodexSettings() {
  return <section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]"><h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1><Connection provider="codex"/><Connection provider="claude"/></section>;
}
