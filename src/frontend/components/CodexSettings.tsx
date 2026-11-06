import { createSignal, For, onMount, Show } from 'solid-js';
import { loadModels, modelStatus, providerName } from '../model-cache';
import type { Provider } from '../types';

function Connection(props: {provider: Provider}) {
  const status = () => modelStatus(props.provider);
  const name = () => providerName(props.provider);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  async function refresh() {
    setLoading(true); setError('');
    try { await loadModels(true, props.provider); }
    catch { setError(`${name()} の状態を確認できませんでした`); }
    finally { setLoading(false); }
  }
  onMount(refresh);
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
  return <div class="card card-border border-base-300 bg-base-100 shadow-sm mt-6 p-6">
    <div class="flex items-center justify-between gap-4"><h2 class="text-[.95rem] font-bold">{name()} 接続</h2><button type="button" class="btn btn-sm" aria-label={`${name()} の接続状態を更新`} disabled={loading()} onClick={refresh}>{loading() ? '確認中...' : '更新'}</button></div>
    <Show when={error()}><p role="alert" class="mt-3 text-sm text-error">{error()}</p></Show>
    <dl class="mt-4 space-y-2 text-sm"><div><dt class="inline font-medium">実行ファイル: </dt><dd class="inline">{status() ? status()!.installed ? '検出済み' : `${name()} CLI をインストールしてください` : '未確認'}</dd></div><div><dt class="inline font-medium">パス: </dt><dd class="inline break-all">{status()?.path ?? '未確認'}</dd></div><div><dt class="inline font-medium">バージョン: </dt><dd class="inline">{status()?.version ?? '未確認'}</dd></div><div><dt class="inline font-medium">確認日時: </dt><dd class="inline">{status()?.checkedAt ? new Date(status()!.checkedAt).toLocaleString() : '未確認'}</dd></div><div><dt class="inline font-medium">認証: </dt><dd class="inline">{authLabel()}</dd></div><div><dt class="inline font-medium">モデル: </dt><dd class="inline"><Show when={status()?.models} fallback="未確認"><For each={status()!.models!}>{(model, index) => <>{index() > 0 ? '、' : ''}{model.name}</>}</For><Show when={status()!.models!.length === 0}>取得できるモデルはありません</Show></Show></dd></div><div><dt class="inline font-medium">利用枠: </dt><dd class="inline">未確認</dd></div></dl>
    <Show when={props.provider === 'claude'}><p class="mt-4 text-sm text-base-content/70">Claude Code 2.1.292 以降とサブスクリプションのログインが必要です。タスクではファイル編集とコマンド実行ができます。ネットワークと外部ツールは無効です。</p></Show>
  </div>;
}
export default function CodexSettings() {
  return <section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]"><h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1><Connection provider="codex"/><Connection provider="claude"/></section>;
}
