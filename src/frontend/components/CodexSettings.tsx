import { createSignal, For, onMount, Show } from 'solid-js';
import { api } from '../api';
import type { CodexStatus } from '../types';

export default function CodexSettings() {
  const [status, setStatus] = createSignal<CodexStatus>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  async function refresh() {
    setLoading(true); setError('');
    try { setStatus(await api<CodexStatus>('/api/codex/status')); }
    catch { setStatus(undefined); setError('Codex の状態を確認できませんでした'); }
    finally { setLoading(false); }
  }
  onMount(refresh);
  const authLabel = () => {
    switch (status()?.auth) {
      case 'chatgpt': return 'ChatGPT でログイン済み';
      case 'apiKey': return 'API キーで認証中';
      case 'other': return 'その他の認証方式';
      case 'none': return 'Codex にログインしてください';
      default: return '未確認';
    }
  };
  return <section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]"><h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1><div class="mt-6 rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm">
    <div class="flex items-center justify-between gap-4"><h2 class="text-[.95rem] font-bold">Codex 接続</h2><button type="button" class="btn btn-sm" disabled={loading()} onClick={refresh}>{loading() ? '確認中...' : '更新'}</button></div>
    <Show when={error()}><p role="alert" class="mt-3 text-sm text-error">{error()}</p></Show>
    <dl class="mt-4 space-y-2 text-sm"><div><dt class="inline font-medium">実行ファイル: </dt><dd class="inline">{status() ? status()!.installed ? '検出済み' : 'Codex CLI をインストールしてください' : '未確認'}</dd></div><div><dt class="inline font-medium">パス: </dt><dd class="inline break-all">{status()?.path ?? '未確認'}</dd></div><div><dt class="inline font-medium">バージョン: </dt><dd class="inline">{status()?.version ?? '未確認'}</dd></div><div><dt class="inline font-medium">確認日時: </dt><dd class="inline">{status()?.checkedAt ? new Date(status()!.checkedAt).toLocaleString() : '未確認'}</dd></div><div><dt class="inline font-medium">認証: </dt><dd class="inline">{authLabel()}</dd></div><div><dt class="inline font-medium">モデル: </dt><dd class="inline"><Show when={status()?.models} fallback="未確認"><For each={status()!.models!}>{(model, index) => <>{index() > 0 ? '、' : ''}{model.name}</>}</For><Show when={status()!.models!.length === 0}>取得できるモデルはありません</Show></Show></dd></div><div><dt class="inline font-medium">利用枠: </dt><dd class="inline">未確認</dd></div></dl>
  </div></section>;
}
